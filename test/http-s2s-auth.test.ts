/**
 * HTTP transport fail-closed auth (CWE-306).
 *
 * Startup requires a real CONDUIT_S2S_SECRET. Known placeholders are rejected
 * even when MCP_ALLOW_INSECURE_DEV=1. That flag is the only empty-secret
 * bypass: it logs a warning and listens on 127.0.0.1 only.
 * /mcp rejects a missing or invalid X-Gateway-S2S header.
 * AUTH_MODE=gateway rejects requests that omit vendor credential headers
 * and must not fall back to UNITRENDS_* in process.env.
 */

import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const constructed: Array<Record<string, unknown>> = [];

vi.mock("@wyre-technology/node-unitrends", () => ({
  UnitrendsClient: vi.fn().mockImplementation(function UnitrendsClient(opts: Record<string, unknown>) {
    constructed.push(opts);
    return {
      appliances: {
        list: vi.fn().mockResolvedValue([{ id: "appliance-from-header" }]),
      },
    };
  }),
}));

import { UnitrendsClient } from "@wyre-technology/node-unitrends";
import { MISSING_S2S_SECRET_ERROR, PLACEHOLDER_S2S_SECRET_ERROR, startHttpTransport } from "../src/index.js";

const S2S_SECRET = "s2s-do-not-log-7f3a";
const ENV_BASE_URL = "https://env.example.invalid";
const ENV_USERNAME = "env-user-must-not-be-used";
const ENV_PASSWORD = "env-password-must-not-be-used";

const PLACEHOLDERS = [
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
] as const;

const ENV_KEYS = [
  "CONDUIT_S2S_SECRET",
  "MCP_ALLOW_INSECURE_DEV",
  "MCP_HTTP_PORT",
  "MCP_HTTP_HOST",
  "AUTH_MODE",
  "UNITRENDS_BASE_URL",
  "UNITRENDS_USERNAME",
  "UNITRENDS_PASSWORD",
  "UNITRENDS_VERIFY_TLS",
  "LOG_LEVEL",
  "MCP_TRANSPORT",
] as const;

const savedEnv = new Map<string, string | undefined>();
const servers: Server[] = [];

function mintS2sHeader(secret: string, unixSeconds = Math.floor(Date.now() / 1000)): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac("sha256", secret).update(message).digest("hex");
  return `${message},v1=${hex}`;
}

function captureStderr(): { text: () => string; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  });
  return {
    text: () => lines.join("\n"),
    restore: () => spy.mockRestore(),
  };
}

function mockExit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${String(code)}`);
  }) as typeof process.exit);
}

interface HttpResult {
  status: number;
  body: string;
}

function sendHttp(options: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<HttpResult> {
  return fetch(`http://127.0.0.1:${options.port}${options.path}`, {
    method: options.method,
    headers: options.headers,
    body: options.body,
    signal: AbortSignal.timeout(5000),
  }).then(async (res) => ({
    status: res.status,
    body: await res.text(),
  }));
}

async function listen(): Promise<{ port: number; address: string; close: () => Promise<void> }> {
  const server = await startHttpTransport();
  servers.push(server);
  const bound = server.address() as AddressInfo | null;
  if (!bound || typeof bound === "string") {
    throw new Error("HTTP server did not bind a TCP port");
  }
  return {
    port: bound.port,
    address: bound.address,
    close: () =>
      new Promise((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function mcpHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...extra,
  };
}

const listCall = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "unitrends_list_appliances", arguments: {} },
});

function assertNoSecrets(text: string): void {
  expect(text).not.toContain(S2S_SECRET);
  expect(text).not.toContain(ENV_PASSWORD);
  expect(text).not.toContain(ENV_USERNAME);
  expect(text).not.toContain(ENV_BASE_URL);
}

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  process.env.MCP_HTTP_PORT = "0";
  process.env.MCP_HTTP_HOST = "127.0.0.1";
  delete process.env.CONDUIT_S2S_SECRET;
  delete process.env.MCP_ALLOW_INSECURE_DEV;
  delete process.env.AUTH_MODE;
  delete process.env.UNITRENDS_BASE_URL;
  delete process.env.UNITRENDS_USERNAME;
  delete process.env.UNITRENDS_PASSWORD;
  delete process.env.UNITRENDS_VERIFY_TLS;
  constructed.length = 0;
  vi.mocked(UnitrendsClient).mockClear();
});

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server?.listening) continue;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

describe("HTTP startup", () => {
  it("refuses to start when CONDUIT_S2S_SECRET is empty", async () => {
    const logs = captureStderr();
    const exitSpy = mockExit();

    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      expect(exitSpy).toHaveBeenCalledWith(1);
      const text = logs.text();
      expect(text).toBe(MISSING_S2S_SECRET_ERROR);
      assertNoSecrets(text);
    } finally {
      exitSpy.mockRestore();
      logs.restore();
    }
  });

  it("refuses to start when CONDUIT_S2S_SECRET is whitespace", async () => {
    process.env.CONDUIT_S2S_SECRET = "   ";
    const logs = captureStderr();
    const exitSpy = mockExit();

    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      expect(logs.text()).toBe(MISSING_S2S_SECRET_ERROR);
    } finally {
      exitSpy.mockRestore();
      logs.restore();
    }
  });

  it.each(["true", "yes", "0", ""])(
    "still refuses when MCP_ALLOW_INSECURE_DEV is %j",
    async (flag) => {
      process.env.MCP_ALLOW_INSECURE_DEV = flag;
      const logs = captureStderr();
      const exitSpy = mockExit();

      try {
        await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
        expect(logs.text()).toBe(MISSING_S2S_SECRET_ERROR);
      } finally {
        exitSpy.mockRestore();
        logs.restore();
      }
    },
  );

  it.each(PLACEHOLDERS)("refuses the known placeholder %j", async (placeholder) => {
    process.env.CONDUIT_S2S_SECRET = placeholder;
    const logs = captureStderr();
    const exitSpy = mockExit();

    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      expect(exitSpy).toHaveBeenCalledWith(1);
      const text = logs.text();
      expect(text).toBe(PLACEHOLDER_S2S_SECRET_ERROR);
      assertNoSecrets(text);
    } finally {
      exitSpy.mockRestore();
      logs.restore();
    }
  });

  it("refuses a placeholder even when MCP_ALLOW_INSECURE_DEV=1", async () => {
    process.env.CONDUIT_S2S_SECRET = "  ChangeMe  ";
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    const logs = captureStderr();
    const exitSpy = mockExit();

    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      const text = logs.text();
      expect(text).toBe(PLACEHOLDER_S2S_SECRET_ERROR);
      expect(text.toLowerCase()).not.toContain("changeme");
    } finally {
      exitSpy.mockRestore();
      logs.restore();
    }
  });

  it("allows startup with a warning when MCP_ALLOW_INSECURE_DEV=1", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    delete process.env.MCP_HTTP_HOST;
    const logs = captureStderr();
    let close: (() => Promise<void>) | undefined;
    try {
      const server = await listen();
      close = server.close;
      expect(server.address).toBe("127.0.0.1");
      const text = logs.text();
      expect(text).toContain("SECURITY WARNING");
      expect(text).toContain("CONDUIT_S2S_SECRET is empty");
      expect(text).toContain("MCP_ALLOW_INSECURE_DEV=1");
      expect(text).toContain("127.0.0.1");
      expect(text).not.toContain("not a loopback address");
      assertNoSecrets(text);
    } finally {
      logs.restore();
      await close?.();
    }
  });

  it.each(["0.0.0.0", "10.1.2.3"])(
    "forces 127.0.0.1 when the dev bypass is set and MCP_HTTP_HOST is %s",
    async (host) => {
      process.env.MCP_ALLOW_INSECURE_DEV = "1";
      process.env.MCP_HTTP_HOST = host;
      const logs = captureStderr();
      let close: (() => Promise<void>) | undefined;
      try {
        const server = await listen();
        close = server.close;
        expect(server.address).toBe("127.0.0.1");
        const text = logs.text();
        expect(text).toContain(`MCP_HTTP_HOST=${host} is not a loopback address`);
        expect(text).toContain("Binding 127.0.0.1 only");
        expect(text).toContain("SECURITY WARNING");
        assertNoSecrets(text);
      } finally {
        logs.restore();
        await close?.();
      }
    },
  );

  it("forces 127.0.0.1 when the dev bypass is set and MCP_HTTP_HOST is localhost", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    process.env.MCP_HTTP_HOST = "localhost";
    const logs = captureStderr();
    let close: (() => Promise<void>) | undefined;
    try {
      const server = await listen();
      close = server.close;
      expect(server.address).toBe("127.0.0.1");
      expect(logs.text()).not.toContain("not a loopback address");
    } finally {
      logs.restore();
      await close?.();
    }
  });

  it("still binds a non-loopback host when CONDUIT_S2S_SECRET is set", async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.MCP_HTTP_HOST = "0.0.0.0";
    const logs = captureStderr();
    let close: (() => Promise<void>) | undefined;
    try {
      const server = await listen();
      close = server.close;
      expect(server.address).toBe("0.0.0.0");
      expect(logs.text()).not.toContain("not a loopback address");
      expect(logs.text()).not.toContain("SECURITY WARNING");
      assertNoSecrets(logs.text());
    } finally {
      logs.restore();
      await close?.();
    }
  });

  it("binds 0.0.0.0 when a secret is set and MCP_HTTP_HOST is unset", async () => {
    delete process.env.MCP_HTTP_HOST;
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    const server = await listen();
    try {
      expect(server.address).toBe("0.0.0.0");
    } finally {
      await server.close();
    }
  });

  it("honors MCP_HTTP_HOST when a secret is set even if the dev flag is also set", async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    process.env.MCP_HTTP_HOST = "0.0.0.0";
    const logs = captureStderr();
    let close: (() => Promise<void>) | undefined;
    try {
      const server = await listen();
      close = server.close;
      expect(server.address).toBe("0.0.0.0");
      expect(logs.text()).not.toContain("SECURITY WARNING");
    } finally {
      logs.restore();
      await close?.();
    }
  });
});

describe("HTTP /mcp authentication", () => {
  beforeEach(() => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = "gateway";
    process.env.UNITRENDS_BASE_URL = ENV_BASE_URL;
    process.env.UNITRENDS_USERNAME = ENV_USERNAME;
    process.env.UNITRENDS_PASSWORD = ENV_PASSWORD;
    process.env.UNITRENDS_VERIFY_TLS = "true";
  });

  it("returns 401 when the S2S header is missing or invalid and does not log the secret", async () => {
    const logs = captureStderr();
    const server = await listen();
    try {
      const missing = await sendHttp({
        port: server.port,
        method: "POST",
        path: "/mcp",
        headers: mcpHeaders({
          "x-unitrends-base-url": "https://header.example",
          "x-unitrends-username": "header-user",
          "x-unitrends-password": "header-password",
        }),
        body: listCall,
      });
      const invalid = await sendHttp({
        port: server.port,
        method: "POST",
        path: "/mcp",
        headers: mcpHeaders({
          "x-gateway-s2s": mintS2sHeader("wrong-secret"),
          "x-unitrends-base-url": "https://header.example",
          "x-unitrends-username": "header-user",
          "x-unitrends-password": "header-password",
        }),
        body: listCall,
      });

      expect(missing.status).toBe(401);
      expect(invalid.status).toBe(401);
      expect(missing.body).toContain("X-Gateway-S2S");
      expect(invalid.body).toContain("X-Gateway-S2S");
      assertNoSecrets(missing.body);
      assertNoSecrets(invalid.body);
      assertNoSecrets(logs.text());
      expect(UnitrendsClient).not.toHaveBeenCalled();
    } finally {
      logs.restore();
      await server.close();
    }
  });

  it("returns 401 in gateway mode without credential headers and does not use env credentials", async () => {
    const server = await listen();
    try {
      const response = await sendHttp({
        port: server.port,
        method: "POST",
        path: "/mcp",
        headers: mcpHeaders({ "x-gateway-s2s": mintS2sHeader(S2S_SECRET) }),
        body: listCall,
      });

      expect(response.status).toBe(401);
      expect(response.body).toContain("Missing credentials");
      expect(response.body).toContain("X-Unitrends-Base-URL");
      expect(response.body).toContain("X-Unitrends-Username");
      expect(response.body).toContain("X-Unitrends-Password");
      assertNoSecrets(response.body);
      expect(UnitrendsClient).not.toHaveBeenCalled();

      const partial = await sendHttp({
        port: server.port,
        method: "POST",
        path: "/mcp",
        headers: mcpHeaders({
          "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
          "x-unitrends-base-url": "https://header.example",
          "x-unitrends-username": "   ",
          "x-unitrends-password": "header-password",
        }),
        body: listCall,
      });
      expect(partial.status).toBe(401);
      expect(partial.body).toContain("X-Unitrends-Username");
      expect(UnitrendsClient).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("accepts a valid S2S header plus credential headers and uses those credentials", async () => {
    const logs = captureStderr();
    const server = await listen();
    try {
      const response = await sendHttp({
        port: server.port,
        method: "POST",
        path: "/mcp",
        headers: mcpHeaders({
          "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
          "x-unitrends-base-url": "https://header.example",
          "x-unitrends-username": "header-user",
          "x-unitrends-password": "header-password",
          "x-unitrends-verify-tls": "false",
        }),
        body: listCall,
      });

      expect(response.status).toBe(200);
      assertNoSecrets(response.body);
      expect(response.body).not.toContain("header-password");
      const payload = JSON.parse(response.body) as {
        result?: { content?: Array<{ text?: string }> };
      };
      const text = payload.result?.content?.[0]?.text ?? "";
      expect(text).toContain("appliance-from-header");
      expect(constructed).toEqual([
        {
          baseUrl: "https://header.example",
          username: "header-user",
          password: "header-password",
          verifyTls: false,
        },
      ]);
      assertNoSecrets(logs.text());
    } finally {
      logs.restore();
      await server.close();
    }
  });

  it("serves /health without authentication and without reading credentials", async () => {
    const server = await listen();
    try {
      const response = await sendHttp({
        port: server.port,
        method: "GET",
        path: "/health",
      });
      expect(response.status).toBe(200);
      const body = JSON.parse(response.body) as { status?: string; authMode?: string };
      expect(body.status).toBe("ok");
      expect(body.authMode).toBe("gateway");
      assertNoSecrets(response.body);
      expect(UnitrendsClient).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
