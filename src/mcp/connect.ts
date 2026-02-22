import { existsSync } from "node:fs";
import { join } from "node:path";
import { auth as mcpAuth } from "@modelcontextprotocol/sdk/client/auth.js";
import { ShadowOAuthProvider } from "./oauth-provider";
import * as oauthCallback from "./oauth-callback";
import { logger } from "../logger";

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

/**
 * Authenticate a single remote MCP server using OAuth.
 * Returns the access token if successful, undefined otherwise.
 */
async function authenticateServer(
  name: string,
  url: string,
  verbose: boolean,
): Promise<string | undefined> {
  const provider = new ShadowOAuthProvider(name, url);

  // First attempt: check cached tokens or try refresh
  let result: Awaited<ReturnType<typeof mcpAuth>>;
  try {
    result = await mcpAuth(provider, { serverUrl: url });
  } catch (err) {
    if (verbose) {
      logger.verbose(`MCP server '${name}': OAuth discovery failed (${err instanceof Error ? err.message : err}), skipping auth`);
    }
    return undefined;
  }

  if (result === "AUTHORIZED") {
    const tokens = await provider.tokens();
    if (verbose) {
      logger.verbose(`MCP server '${name}': authenticated (cached)`);
    }
    return tokens?.access_token;
  }

  // REDIRECT: need interactive browser auth
  const authUrl = provider.pendingAuthUrl;
  if (!authUrl) {
    logger.warn(`MCP server '${name}': OAuth redirect but no authorization URL`);
    return undefined;
  }

  logger.verbose(`MCP server '${name}': opening browser for authorization...`);
  console.log();
  console.log(`  Authenticate MCP server '${name}':`);
  console.log(`  ${authUrl.toString()}`);
  console.log();

  // Start callback server and register the callback BEFORE opening the browser
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

  // Exchange the code for tokens
  try {
    const exchangeResult = await mcpAuth(provider, {
      serverUrl: url,
      authorizationCode: code,
    });

    if (exchangeResult === "AUTHORIZED") {
      const tokens = await provider.tokens();
      logger.verbose(`MCP server '${name}': authenticated`);
      return tokens?.access_token;
    }
  } catch (err) {
    logger.warn(`MCP server '${name}': token exchange failed (${err instanceof Error ? err.message : err})`);
  }

  return undefined;
}

/**
 * Read .mcp.json, authenticate any remote servers via OAuth, and return
 * the full MCP servers config with Bearer tokens injected.
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

  // Identify remote servers
  const remoteEntries = Object.entries(servers).filter(([, config]) => isRemoteServer(config));

  if (remoteEntries.length === 0) return undefined; // No remote servers, let SDK auto-load

  // Authenticate each remote server
  let needsCallbackCleanup = false;
  for (const [name, config] of remoteEntries) {
    if (!isRemoteServer(config)) continue;

    // Skip if user already set an Authorization header
    if (config.headers?.Authorization || config.headers?.authorization) {
      if (verbose) {
        logger.verbose(`MCP server '${name}': using existing Authorization header`);
      }
      continue;
    }

    const token = await authenticateServer(name, config.url, verbose);
    if (token) {
      config.headers = { ...config.headers, Authorization: `Bearer ${token}` };
      needsCallbackCleanup = true;
    }
  }

  if (needsCallbackCleanup) {
    oauthCallback.stop();
  }

  return servers;
}
