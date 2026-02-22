import { existsSync } from "node:fs";
import { join } from "node:path";
import { auth as mcpAuth } from "@modelcontextprotocol/sdk/client/auth.js";
import { ShadowOAuthProvider } from "./oauth-provider";
import * as oauthCallback from "./oauth-callback";
import { logger, colors } from "../logger";

const { RESET, DIM, GREEN, YELLOW, RED, BOLD } = colors;

export type McpServerConfig =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "sse"; url: string; headers?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> };

export type McpServersMap = Record<string, McpServerConfig>;

/**
 * Parse an MCP config object, handling both flat and nested mcpServers formats.
 */
function parseMcpConfig(json: unknown): McpServersMap {
  if (typeof json !== "object" || json === null) return {};

  const obj = json as Record<string, unknown>;

  // Nested: { mcpServers: { name: config } }
  if (obj.mcpServers && typeof obj.mcpServers === "object") {
    return { ...(obj.mcpServers as McpServersMap) };
  }

  // Flat: { name: config }
  const result: McpServersMap = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "object" && value !== null) {
      result[key] = value as McpServerConfig;
    }
  }
  return result;
}

function isRemoteServer(config: McpServerConfig): config is { type: "http" | "sse"; url: string; headers?: Record<string, string> } {
  return config.type === "http" || config.type === "sse";
}

function openBrowser(url: URL): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    Bun.spawnSync([cmd, url.toString()]);
  } catch {
    // If opening fails, user can copy the URL from the terminal
  }
}

async function prompt(question: string): Promise<string> {
  process.stdout.write(question);
  for await (const line of console) {
    return line.trim();
  }
  return "";
}

// ── Phase 1: Silent probe ──

type ProbeResult =
  | { status: "authorized"; token: string }
  | { status: "needs_auth"; provider: ShadowOAuthProvider }
  | { status: "skipped"; reason: string };

/**
 * Probe a remote server for cached/refreshable tokens without user interaction.
 * Returns the provider with pendingAuthUrl set if interactive auth is needed.
 */
async function probeServer(
  name: string,
  url: string,
  verbose: boolean,
): Promise<ProbeResult> {
  const provider = new ShadowOAuthProvider(name, url);

  try {
    const result = await mcpAuth(provider, { serverUrl: url });

    if (result === "AUTHORIZED") {
      const tokens = await provider.tokens();
      if (verbose) {
        logger.verbose(`MCP server '${name}': authenticated (cached)`);
      }
      return { status: "authorized", token: tokens?.access_token ?? "" };
    }

    // REDIRECT: needs interactive auth. Provider has pendingAuthUrl set.
    return { status: "needs_auth", provider };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (verbose) {
      logger.verbose(`MCP server '${name}': OAuth discovery failed (${reason}), skipping auth`);
    }
    return { status: "skipped", reason };
  }
}

// ── Phase 2: Interactive auth ──

type PendingServer = {
  name: string;
  url: string;
  provider: ShadowOAuthProvider;
};

/**
 * Run the browser-based OAuth flow for a single server.
 * Uses the provider from the probe phase (already has pendingAuthUrl and saved state).
 */
async function performInteractiveAuth(
  name: string,
  url: string,
  provider: ShadowOAuthProvider,
  verbose: boolean,
): Promise<string | undefined> {
  const authUrl = provider.pendingAuthUrl;
  if (!authUrl) {
    logger.warn(`MCP server '${name}': OAuth redirect but no authorization URL`);
    return undefined;
  }

  console.log();
  console.log(`  Opening browser for '${name}'...`);
  console.log(`  ${DIM}${authUrl.toString()}${RESET}`);
  console.log();

  await oauthCallback.ensureRunning();
  const state = await provider.state();
  const callbackPromise = oauthCallback.waitForCallback(state);
  openBrowser(authUrl);

  let code: string;
  try {
    code = await callbackPromise;
  } catch (err) {
    logger.warn(`MCP server '${name}': OAuth callback failed (${err instanceof Error ? err.message : err})`);
    return undefined;
  }

  try {
    const exchangeResult = await mcpAuth(provider, {
      serverUrl: url,
      authorizationCode: code,
    });

    if (exchangeResult === "AUTHORIZED") {
      const tokens = await provider.tokens();
      if (verbose) {
        logger.verbose(`MCP server '${name}': authenticated`);
      }
      return tokens?.access_token;
    }
  } catch (err) {
    logger.warn(`MCP server '${name}': token exchange failed (${err instanceof Error ? err.message : err})`);
  }

  return undefined;
}

/**
 * Display an interactive menu for servers that need browser-based OAuth.
 * Returns a map of server name → access token for successfully authenticated servers.
 */
async function showAuthMenu(
  pending: PendingServer[],
  verbose: boolean,
): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  while (pending.length > 0) {
    console.log();
    console.log(`${BOLD}MCP servers requiring authentication:${RESET}`);
    console.log();

    for (let i = 0; i < pending.length; i++) {
      const { name, url } = pending[i];
      let host: string;
      try {
        host = new URL(url).host;
      } catch {
        host = url;
      }
      console.log(`  ${BOLD}${i + 1}.${RESET} ${name} ${DIM}(${host})${RESET}`);
    }

    const skipOption = pending.length + 1;
    console.log();
    console.log(`  ${DIM}${skipOption}. Skip remaining and continue${RESET}`);
    console.log();

    const choice = await prompt(`Choose [1-${skipOption}]: `);
    const num = parseInt(choice, 10);

    if (num === skipOption || choice === "" || choice === "s" || choice === "S") {
      if (pending.length > 0) {
        const skippedNames = pending.map((s) => s.name).join(", ");
        console.log(`${DIM}  Skipping: ${skippedNames}${RESET}`);
      }
      break;
    }

    if (num < 1 || num > pending.length || isNaN(num)) {
      console.log(`${RED}  Invalid choice.${RESET}`);
      continue;
    }

    const server = pending[num - 1];
    const token = await performInteractiveAuth(server.name, server.url, server.provider, verbose);

    if (token) {
      results.set(server.name, token);
      pending.splice(num - 1, 1);
      console.log(`  ${GREEN}Authenticated '${server.name}'${RESET}`);
    } else {
      console.log(`  ${YELLOW}Authentication failed for '${server.name}'. You can retry or skip.${RESET}`);
    }
  }

  return results;
}

// ── Main entry point ──

/**
 * Read .mcp.json, authenticate any remote servers via OAuth, and return
 * the full MCP servers config with Bearer tokens injected.
 *
 * Phase 1: Silently check cached/refreshable tokens for each remote server.
 * Phase 2: Present an interactive menu for servers that need browser-based auth.
 *
 * Returns undefined if there are no remote servers (letting the SDK auto-load).
 */
export async function authenticateMcpServers(
  projectRoot: string,
  verbose: boolean,
): Promise<McpServersMap | undefined> {
  const configPath = join(projectRoot, ".mcp.json");
  if (!existsSync(configPath)) return undefined;

  let raw: unknown;
  try {
    raw = await Bun.file(configPath).json();
  } catch {
    return undefined;
  }

  const servers = parseMcpConfig(raw);
  if (Object.keys(servers).length === 0) return undefined;

  const remoteEntries = Object.entries(servers).filter(([, config]) => isRemoteServer(config));
  if (remoteEntries.length === 0) return undefined;

  // ── Phase 1: Silent probe ──
  const pending: PendingServer[] = [];
  const connected: string[] = [];
  const skipped: string[] = [];

  for (const [name, config] of remoteEntries) {
    if (!isRemoteServer(config)) continue;

    // Skip servers with explicit Authorization header
    if (config.headers?.Authorization || config.headers?.authorization) {
      connected.push(name);
      if (verbose) {
        logger.verbose(`MCP server '${name}': using existing Authorization header`);
      }
      continue;
    }

    const probe = await probeServer(name, config.url, verbose);

    if (probe.status === "authorized") {
      config.headers = { ...config.headers, Authorization: `Bearer ${probe.token}` };
      connected.push(name);
    } else if (probe.status === "needs_auth") {
      pending.push({ name, url: config.url, provider: probe.provider });
    } else {
      skipped.push(name);
    }
  }

  // ── Report connection status ──
  const allStatuses: { name: string; label: string }[] = [
    ...connected.map((n) => ({ name: n, label: `${GREEN}connected${RESET}` })),
    ...skipped.map((n) => ({ name: n, label: `${YELLOW}no auth${RESET}` })),
    ...pending.map((s) => ({ name: s.name, label: `${YELLOW}needs auth${RESET}` })),
  ];

  if (allStatuses.length > 0) {
    const maxName = Math.max(...allStatuses.map((s) => s.name.length));
    console.log();
    for (const { name, label } of allStatuses) {
      const dots = ".".repeat(Math.max(2, maxName - name.length + 12));
      console.log(`  ${name} ${DIM}${dots}${RESET} ${label}`);
    }
    console.log();
  }

  // ── Phase 2: Interactive menu ──
  if (pending.length > 0) {
    const authenticated = await showAuthMenu(pending, verbose);

    for (const [name, token] of authenticated) {
      const config = servers[name];
      if (isRemoteServer(config)) {
        config.headers = { ...config.headers, Authorization: `Bearer ${token}` };
      }
    }

    oauthCallback.stop();
  }

  return servers;
}
