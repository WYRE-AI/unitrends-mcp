#!/usr/bin/env node
/**
 * Unitrends MCP Server
 *
 * Exposes the Unitrends Backup API to Claude and other MCP clients.
 * Accepts credentials via environment variables (env mode) or per-request
 * HTTP headers (gateway mode).
 *
 * Supports both stdio (default) and HTTP (StreamableHTTP) transports.
 * The server itself (tools, resources, handlers) is built by
 * createMcpServer in mcp-server.ts.
 *
 * HTTP transport refuses to start unless CONDUIT_S2S_SECRET is a real
 * secret. Known placeholders are rejected. MCP_ALLOW_INSECURE_DEV=1 is a
 * local-only escape hatch for an empty secret: it logs a warning, does not
 * enforce X-Gateway-S2S, and listens on 127.0.0.1 only. A configured secret
 * still honors MCP_HTTP_HOST. Gateway mode never falls back to UNITRENDS_*
 * env credentials. /health stays unauthenticated and does not read
 * credentials. stdio does not use S2S auth.
 */

import { createServer, IncomingMessage, ServerResponse, Server as HttpServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createMcpServer, parseBool, type UnitrendsCredentials } from "./mcp-server.js";
import { verifyS2sHeader, S2S_HEADER } from "./s2s-verify.js";

/** Public example values. A copied placeholder must not verify as a real secret. */
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  "replace-with-a-real-secret",
  "your-s2s-secret",
  "your-secret",
  "changeme",
  "change-me",
  "placeholder",
  "secret",
  "example",
  "replace-me",
  "s2s-secret",
]);

const LOOPBACK_HOST = "127.0.0.1";

export const MISSING_S2S_SECRET_ERROR =
  "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is empty. " +
  "Set CONDUIT_S2S_SECRET to the gateway-provisioned secret (openssl rand -hex 32), " +
  "or set MCP_ALLOW_INSECURE_DEV=1 for local development only.";

export const PLACEHOLDER_S2S_SECRET_ERROR =
  "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is a known placeholder. " +
  "Generate a secret with `openssl rand -hex 32` and set CONDUIT_S2S_SECRET to that value. " +
  "A known placeholder is refused even when MCP_ALLOW_INSECURE_DEV=1; unset the secret to use that bypass.";

const INSECURE_DEV_WARNING =
  "SECURITY WARNING: CONDUIT_S2S_SECRET is empty and MCP_ALLOW_INSECURE_DEV=1. " +
  "HTTP /mcp is not enforcing X-Gateway-S2S and listens on 127.0.0.1 only. " +
  "Do not use this outside local development.";

function refuseStart(message: string): never {
  console.error(message);
  process.exit(1);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Hosts that count as loopback when deciding whether the dev bypass must warn. */
function isLoopbackBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.+)\]$/, "$1");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

/**
 * Fail closed. A known placeholder is never a configured secret, including
 * when MCP_ALLOW_INSECURE_DEV=1 is also set. Empty is the only case the dev
 * flag may bypass, and that bypass does not check X-Gateway-S2S.
 * The secret value is never written to logs.
 */
function resolveS2sSecret(): string {
  const raw = (process.env.CONDUIT_S2S_SECRET ?? "").trim();
  if (raw && KNOWN_PLACEHOLDER_SECRETS.has(raw.toLowerCase())) {
    refuseStart(PLACEHOLDER_S2S_SECRET_ERROR);
  }
  if (raw) return raw;
  if (process.env.MCP_ALLOW_INSECURE_DEV === "1") return "";
  refuseStart(MISSING_S2S_SECRET_ERROR);
}

/**
 * No real secret: force 127.0.0.1, even when MCP_HTTP_HOST is a wider address.
 * A configured secret honors MCP_HTTP_HOST and keeps the historical 0.0.0.0
 * default when that variable is unset.
 */
function resolveHttpBindHost(s2sSecret: string): string {
  const configured = (process.env.MCP_HTTP_HOST ?? "").trim();
  if (s2sSecret) return configured || "0.0.0.0";
  if (configured && !isLoopbackBindHost(configured)) {
    console.error(
      `WARNING: MCP_HTTP_HOST=${configured} is not a loopback address. ` +
        "MCP_ALLOW_INSECURE_DEV=1 without CONDUIT_S2S_SECRET cannot listen there. " +
        `Binding ${LOOPBACK_HOST} only.`,
    );
  }
  return LOOPBACK_HOST;
}

// ---------------------------------------------------------------------------
// Transport: stdio (default)
// ---------------------------------------------------------------------------

async function startStdioTransport(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Unitrends MCP server running on stdio");
}

// ---------------------------------------------------------------------------
// Transport: HTTP (StreamableHTTPServerTransport)
// ---------------------------------------------------------------------------

let httpServer: HttpServer | undefined;

export async function startHttpTransport(): Promise<HttpServer> {
  const port = parseInt(process.env.MCP_HTTP_PORT || "8080", 10);
  const s2sSecret = resolveS2sSecret();
  const host = resolveHttpBindHost(s2sSecret);
  const authMode = process.env.AUTH_MODE || "env";
  const isGatewayMode = authMode === "gateway";

  if (!s2sSecret) {
    // Logged only after the loopback bind is chosen, and at console.error so
    // it cannot be filtered out. The secret value is never included.
    console.error(INSECURE_DEV_WARNING);
  }

  const bound = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    // Health endpoint — container liveness, not credential readiness.
    // Unauthenticated and must not read vendor credentials.
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          transport: "http",
          authMode: isGatewayMode ? "gateway" : "env",
          timestamp: new Date().toISOString(),
        })
      );
      return;
    }

    if (url.pathname === "/mcp") {
      // Empty s2sSecret is only reachable when MCP_ALLOW_INSECURE_DEV=1;
      // startup refuses otherwise. A configured secret is always enforced,
      // before any credential extraction.
      if (s2sSecret && !verifyS2sHeader(headerValue(req.headers[S2S_HEADER]), s2sSecret)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway.",
          })
        );
        return;
      }

      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Method not allowed" },
            id: null,
          })
        );
        return;
      }

      // Gateway mode: credentials must arrive on every request via headers.
      // Reject explicitly if missing rather than falling through — falling
      // through would resolve UNITRENDS_* from the process environment.
      let gatewayCredentials: UnitrendsCredentials | undefined;
      if (isGatewayMode) {
        const baseUrl = headerValue(req.headers["x-unitrends-base-url"]);
        const username = headerValue(req.headers["x-unitrends-username"]);
        const password = headerValue(req.headers["x-unitrends-password"]);
        const verifyTlsRaw = headerValue(req.headers["x-unitrends-verify-tls"]);

        const missing: string[] = [];
        if (!baseUrl) missing.push("X-Unitrends-Base-URL");
        if (!username) missing.push("X-Unitrends-Username");
        if (!password) missing.push("X-Unitrends-Password");

        if (missing.length > 0) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "Missing credentials",
              message:
                "Gateway mode requires X-Unitrends-Base-URL, X-Unitrends-Username, and X-Unitrends-Password headers (X-Unitrends-Verify-TLS optional, default true)",
              required: missing,
            })
          );
          return;
        }

        gatewayCredentials = {
          baseUrl: baseUrl!,
          username: username!,
          password: password!,
          verifyTls: parseBool(verifyTlsRaw, true),
        };
      }

      // Stateless: fresh server + transport per request
      const server = createMcpServer(gatewayCredentials);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      res.on("close", () => {
        transport.close();
        server.close();
      });

      server
        .connect(transport as unknown as Transport)
        .then(() => {
          transport.handleRequest(req, res);
        })
        .catch((err) => {
          console.error("MCP transport error:", err);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                error: { code: -32603, message: "Internal error" },
                id: null,
              })
            );
          }
        });

      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found", endpoints: ["/mcp", "/health"] }));
  });

  httpServer = bound;

  await new Promise<void>((resolve) => {
    bound.listen(port, host, () => {
      console.error(`Unitrends MCP server listening on http://${host}:${port}/mcp`);
      console.error(`Health check available at http://${host}:${port}/health`);
      console.error(
        `Authentication mode: ${isGatewayMode ? "gateway (header-based)" : "env (environment variables)"}`
      );
      resolve();
    });
  });

  return bound;
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function setupShutdownHandlers(): void {
  const shutdown = async () => {
    console.error("Shutting down Unitrends MCP server...");
    if (httpServer) {
      await new Promise<void>((resolve, reject) => {
        httpServer!.close((err) => (err ? reject(err) : resolve()));
      });
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  setupShutdownHandlers();

  const transportType = process.env.MCP_TRANSPORT || "stdio";

  if (transportType === "http") {
    await startHttpTransport();
  } else {
    await startStdioTransport();
  }
}

// Vitest imports this module to call startHttpTransport. Skip the CLI
// entrypoint there. `node dist/index.js` still starts stdio or HTTP.
if (process.env.VITEST !== "true") {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
