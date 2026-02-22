import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".shadow");
const MCP_AUTH_FILE = join(CONFIG_DIR, "mcp-auth.json");

export type McpAuthEntry = {
  tokens?: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number; // seconds since epoch
  };
  clientInfo?: {
    clientId: string;
    clientSecret?: string;
    clientIdIssuedAt?: number;
    clientSecretExpiresAt?: number;
  };
  codeVerifier?: string;
  oauthState?: string;
  serverUrl?: string;
};

type McpAuthStore = Record<string, McpAuthEntry>;

function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

async function readStore(): Promise<McpAuthStore> {
  try {
    const file = Bun.file(MCP_AUTH_FILE);
    if (!(await file.exists())) return {};
    return (await file.json()) as McpAuthStore;
  } catch {
    return {};
  }
}

async function writeStore(store: McpAuthStore): Promise<void> {
  ensureConfigDir();
  writeFileSync(MCP_AUTH_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

/**
 * Get an entry for a server, scoped to its URL.
 * Returns undefined if the URL doesn't match (prevents token reuse across servers).
 */
export async function getEntry(name: string, serverUrl: string): Promise<McpAuthEntry | undefined> {
  const store = await readStore();
  const entry = store[name];
  if (!entry) return undefined;
  if (entry.serverUrl && entry.serverUrl !== serverUrl) return undefined;
  return entry;
}

export async function updateTokens(
  name: string,
  tokens: McpAuthEntry["tokens"],
  serverUrl: string,
): Promise<void> {
  const store = await readStore();
  store[name] = { ...store[name], tokens, serverUrl };
  await writeStore(store);
}

export async function updateClientInfo(
  name: string,
  clientInfo: McpAuthEntry["clientInfo"],
  serverUrl: string,
): Promise<void> {
  const store = await readStore();
  store[name] = { ...store[name], clientInfo, serverUrl };
  await writeStore(store);
}

export async function updateCodeVerifier(name: string, codeVerifier: string): Promise<void> {
  const store = await readStore();
  store[name] = { ...store[name], codeVerifier };
  await writeStore(store);
}

export async function updateOAuthState(name: string, oauthState: string): Promise<void> {
  const store = await readStore();
  store[name] = { ...store[name], oauthState };
  await writeStore(store);
}

export async function clearEntry(name: string): Promise<void> {
  const store = await readStore();
  delete store[name];
  await writeStore(store);
}
