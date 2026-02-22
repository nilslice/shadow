import { logger } from "../logger";

export const OAUTH_CALLBACK_PORT = 19876;
export const OAUTH_CALLBACK_PATH = "/oauth/callback";

const HTML_SUCCESS = `<!DOCTYPE html>
<html>
<head>
  <title>shadow - authorized</title>
  <style>
    body {
      margin: 0;
      height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      background: #1a1a1a;
      color: #999;
      font-family: "SF Mono", "Fira Code", "JetBrains Mono", Menlo, Consolas, monospace;
    }
    .container {
      text-align: center;
      padding: 2rem;
    }
    h1 {
      color: #ccc;
      font-weight: 400;
      font-size: 1.2rem;
      margin-bottom: 0.5rem;
    }
    p {
      font-size: 0.85rem;
      color: #666;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>authorized</h1>
    <p>you can close this tab and return to your terminal.</p>
  </div>
  <script>setTimeout(() => window.close(), 3000);</script>
</body>
</html>`;

function htmlError(error: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>shadow - authorization failed</title>
  <style>
    body {
      margin: 0;
      height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      background: #1a1a1a;
      color: #999;
      font-family: "SF Mono", "Fira Code", "JetBrains Mono", Menlo, Consolas, monospace;
    }
    .container {
      text-align: center;
      padding: 2rem;
    }
    h1 {
      color: #ccc;
      font-weight: 400;
      font-size: 1.2rem;
      margin-bottom: 0.5rem;
    }
    p {
      font-size: 0.85rem;
      color: #666;
    }
    .error {
      color: #a66;
      font-size: 0.8rem;
      margin-top: 1rem;
      padding: 1rem;
      background: rgba(170, 102, 102, 0.08);
      border-radius: 4px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>authorization failed</h1>
    <p>an error occurred during authorization.</p>
    <div class="error">${error}</div>
  </div>
</body>
</html>`;
}

interface PendingAuth {
  resolve: (code: string) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

let server: ReturnType<typeof Bun.serve> | undefined;
const pendingAuths = new Map<string, PendingAuth>();

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export async function ensureRunning(): Promise<void> {
  if (server) return;

  server = Bun.serve({
    port: OAUTH_CALLBACK_PORT,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname !== OAUTH_CALLBACK_PATH) {
        return new Response("Not found", { status: 404 });
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      const errorDescription = url.searchParams.get("error_description");

      if (!state) {
        return new Response(htmlError("Missing state parameter"), {
          status: 400,
          headers: { "Content-Type": "text/html" },
        });
      }

      if (error) {
        const errorMsg = errorDescription || error;
        const pending = pendingAuths.get(state);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingAuths.delete(state);
          pending.reject(new Error(errorMsg));
        }
        return new Response(htmlError(errorMsg), {
          headers: { "Content-Type": "text/html" },
        });
      }

      if (!code) {
        return new Response(htmlError("No authorization code provided"), {
          status: 400,
          headers: { "Content-Type": "text/html" },
        });
      }

      const pending = pendingAuths.get(state);
      if (!pending) {
        return new Response(htmlError("Invalid or expired state parameter"), {
          status: 400,
          headers: { "Content-Type": "text/html" },
        });
      }

      clearTimeout(pending.timeout);
      pendingAuths.delete(state);
      pending.resolve(code);

      return new Response(HTML_SUCCESS, {
        headers: { "Content-Type": "text/html" },
      });
    },
  });

  logger.verbose(`OAuth callback server listening on port ${OAUTH_CALLBACK_PORT}`);
}

export function waitForCallback(oauthState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pendingAuths.has(oauthState)) {
        pendingAuths.delete(oauthState);
        reject(new Error("OAuth callback timeout (5 minutes)"));
      }
    }, CALLBACK_TIMEOUT_MS);

    pendingAuths.set(oauthState, { resolve, reject, timeout });
  });
}

export function stop(): void {
  if (server) {
    server.stop();
    server = undefined;
  }

  for (const [, pending] of pendingAuths) {
    clearTimeout(pending.timeout);
    pending.reject(new Error("OAuth callback server stopped"));
  }
  pendingAuths.clear();
}
