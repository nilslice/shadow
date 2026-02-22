import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import * as authStore from "./auth-store";
import { OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_PATH } from "./oauth-callback";

const REDIRECT_URI = `http://127.0.0.1:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`;

/**
 * OAuthClientProvider for shadow's MCP OAuth flow.
 * Delegates token and client-info persistence to auth-store.
 * Captures the authorization URL so the caller can open the browser.
 */
export class ShadowOAuthProvider implements OAuthClientProvider {
  private _pendingAuthUrl: URL | undefined;
  private _state: string;

  constructor(
    private mcpName: string,
    private serverUrl: string,
  ) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    this._state = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  get redirectUrl(): URL {
    return new URL(REDIRECT_URI);
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [REDIRECT_URI],
      client_name: "shadow",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  /** The authorization URL captured during the REDIRECT flow. */
  get pendingAuthUrl(): URL | undefined {
    return this._pendingAuthUrl;
  }

  async state(): Promise<string> {
    await authStore.updateOAuthState(this.mcpName, this._state);
    return this._state;
  }

  async clientInformation() {
    const entry = await authStore.getEntry(this.mcpName, this.serverUrl);
    if (entry?.clientInfo) {
      // Check if client secret has expired
      if (
        entry.clientInfo.clientSecretExpiresAt &&
        entry.clientInfo.clientSecretExpiresAt < Date.now() / 1000
      ) {
        return undefined;
      }
      return {
        client_id: entry.clientInfo.clientId,
        client_secret: entry.clientInfo.clientSecret,
      };
    }
    return undefined;
  }

  async saveClientInformation(info: { client_id: string; client_secret?: string; client_id_issued_at?: number; client_secret_expires_at?: number }): Promise<void> {
    await authStore.updateClientInfo(
      this.mcpName,
      {
        clientId: info.client_id,
        clientSecret: info.client_secret,
        clientIdIssuedAt: info.client_id_issued_at,
        clientSecretExpiresAt: info.client_secret_expires_at,
      },
      this.serverUrl,
    );
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const entry = await authStore.getEntry(this.mcpName, this.serverUrl);
    if (!entry?.tokens) return undefined;

    return {
      access_token: entry.tokens.accessToken,
      token_type: "Bearer",
      refresh_token: entry.tokens.refreshToken,
      ...(entry.tokens.expiresAt
        ? { expires_in: Math.max(0, entry.tokens.expiresAt - Math.floor(Date.now() / 1000)) }
        : {}),
    };
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await authStore.updateTokens(
      this.mcpName,
      {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: tokens.expires_in
          ? Math.floor(Date.now() / 1000) + tokens.expires_in
          : undefined,
      },
      this.serverUrl,
    );
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this._pendingAuthUrl = authorizationUrl;
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await authStore.updateCodeVerifier(this.mcpName, codeVerifier);
  }

  async codeVerifier(): Promise<string> {
    const entry = await authStore.getEntry(this.mcpName, this.serverUrl);
    return entry?.codeVerifier ?? "";
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens"): Promise<void> {
    if (scope === "all") {
      await authStore.clearEntry(this.mcpName);
    }
  }
}
