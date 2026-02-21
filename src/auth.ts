import { mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "./logger";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPES = "org:create_api_key user:profile user:inference";
const TOKEN_ENDPOINT = "https://console.anthropic.com/v1/oauth/token";

const CONFIG_DIR = join(homedir(), ".shadow");
const CREDENTIALS_FILE = join(CONFIG_DIR, "credentials.json");

// Known locations for existing Anthropic credentials
const KEYCHAIN_SERVICES = [
  { service: "Claude Code", account: undefined },
  { service: "Claude Code-credentials", account: undefined },
];

type OAuthCredentials = {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
};

type ApiKeyCredentials = {
  type: "apikey";
  key: string;
};

type Credentials = OAuthCredentials | ApiKeyCredentials;

/**
 * Try to read an API key from the macOS Keychain, where Claude Code stores credentials.
 */
async function readKeychainKey(): Promise<string | null> {
  if (process.platform !== "darwin") return null;

  for (const { service, account } of KEYCHAIN_SERVICES) {
    try {
      const args = ["find-generic-password", "-s", service, "-w"];
      if (account) args.splice(3, 0, "-a", account);
      const result = Bun.spawnSync(["security", ...args]);
      const stdout = result.stdout.toString().trim();
      if (result.exitCode === 0 && stdout.startsWith("sk-ant-")) {
        return stdout;
      }
    } catch {
      // Not found, try next
    }
  }

  return null;
}

function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

async function loadCredentials(): Promise<Credentials | null> {
  try {
    const file = Bun.file(CREDENTIALS_FILE);
    if (!(await file.exists())) return null;
    return (await file.json()) as Credentials;
  } catch {
    return null;
  }
}

async function saveCredentials(creds: Credentials) {
  ensureConfigDir();
  await Bun.write(CREDENTIALS_FILE, JSON.stringify(creds, null, 2));
}

// PKCE helpers using Web Crypto API
async function generatePKCE(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64url(bytes);
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  const challenge = base64url(new Uint8Array(hash));
  return { verifier, challenge };
}

function base64url(bytes: Uint8Array): string {
  const str = btoa(String.fromCharCode(...bytes));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function prompt(question: string): Promise<string> {
  process.stdout.write(question);
  for await (const line of console) {
    return line.trim();
  }
  return "";
}

async function oauthFlow(mode: "max" | "console"): Promise<OAuthCredentials> {
  const pkce = await generatePKCE();

  const host =
    mode === "max" ? "claude.ai" : "console.anthropic.com";
  const url = new URL(`https://${host}/oauth/authorize`);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", pkce.verifier);

  console.log();
  console.log("Open this URL in your browser to authenticate:");
  console.log();
  console.log(`  ${url.toString()}`);
  console.log();

  // Try to open in default browser
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    Bun.spawnSync([cmd, url.toString()]);
  } catch {
    // If opening fails, user can copy the URL manually
  }

  const code = await prompt("Paste the authorization code here: ");

  if (!code) {
    throw new Error("No authorization code provided");
  }

  const splits = code.split("#");
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: splits[0],
      state: splits[1],
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: pkce.verifier,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${body}`);
  }

  const json = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    type: "oauth",
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

async function refreshToken(
  creds: OAuthCredentials,
): Promise<OAuthCredentials> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: creds.refresh,
    }),
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed (${response.status})`);
  }

  const json = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    type: "oauth",
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

function applyCredentials(creds: Credentials) {
  if (creds.type === "apikey") {
    process.env.ANTHROPIC_API_KEY = creds.key;
  } else {
    process.env.ANTHROPIC_API_KEY = creds.access;
  }
}

/**
 * Ensures authentication is configured. Checks env vars, stored credentials,
 * and prompts for setup if needed. Sets ANTHROPIC_API_KEY in the environment.
 */
export async function ensureAuth(): Promise<void> {
  // 1. Check env var
  if (process.env.ANTHROPIC_API_KEY) {
    return;
  }

  // 2. Check cloud provider env vars
  if (
    process.env.CLAUDE_CODE_USE_BEDROCK ||
    process.env.CLAUDE_CODE_USE_VERTEX ||
    process.env.CLAUDE_CODE_USE_FOUNDRY
  ) {
    return;
  }

  // 3. Check stored credentials
  const stored = await loadCredentials();
  if (stored) {
    if (stored.type === "apikey") {
      applyCredentials(stored);
      return;
    }

    // OAuth: check if token needs refresh
    if (stored.type === "oauth") {
      if (stored.expires > Date.now()) {
        applyCredentials(stored);
        return;
      }

      // Try refresh
      try {
        const refreshed = await refreshToken(stored);
        await saveCredentials(refreshed);
        applyCredentials(refreshed);
        return;
      } catch (err) {
        logger.warn(
          `Token refresh failed, re-authenticating: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  // 4. Check macOS Keychain for existing Claude Code credentials
  const keychainKey = await readKeychainKey();
  if (keychainKey) {
    logger.verbose("Found existing Claude Code API key in macOS Keychain");
    process.env.ANTHROPIC_API_KEY = keychainKey;
    return;
  }

  // 5. Interactive setup
  console.log();
  console.log("No credentials found. How would you like to authenticate?");
  console.log();
  console.log("  1. Log in with Claude (Pro/Max subscription)");
  console.log("  2. Log in with Anthropic Console (API key billing)");
  console.log("  3. Enter an API key manually");
  console.log("  4. Configure cloud provider (Bedrock/Vertex/Azure)");
  console.log();

  const choice = await prompt("Choose [1-4]: ");

  switch (choice) {
    case "1": {
      const creds = await oauthFlow("max");
      await saveCredentials(creds);
      applyCredentials(creds);
      break;
    }
    case "2": {
      const creds = await oauthFlow("console");
      await saveCredentials(creds);
      applyCredentials(creds);
      break;
    }
    case "3": {
      const key = await prompt("API key: ");
      if (!key) throw new Error("No API key provided");
      const creds: ApiKeyCredentials = { type: "apikey", key };
      await saveCredentials(creds);
      applyCredentials(creds);
      break;
    }
    case "4": {
      console.log();
      console.log("Set one of these environment variables before running shadow:");
      console.log("  CLAUDE_CODE_USE_BEDROCK=1  (+ AWS credentials)");
      console.log("  CLAUDE_CODE_USE_VERTEX=1   (+ Google Cloud credentials)");
      console.log("  CLAUDE_CODE_USE_FOUNDRY=1  (+ Azure credentials)");
      console.log();
      process.exit(0);
    }
    default:
      throw new Error(`Invalid choice: ${choice}`);
  }
}
