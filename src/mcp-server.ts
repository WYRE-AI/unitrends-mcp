/**
 * Unitrends MCP server factory.
 *
 * Builds a fully-wired MCP Server (tools + MCP Apps resources) for a set of
 * credentials. The transports live in index.ts; HTTP mode creates a fresh
 * server per request (stateless), so everything request-scoped lives here.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { setServerRef } from "./utils/server-ref.js";
import {
  APPLIANCE_CARD_RESOURCE_URI,
  MCP_APP_RESOURCE_MIME,
  applyBrandInjection,
  resolveBrandFromEnv,
} from "./appliance-card.js";
import { APPLIANCE_CARD_HTML } from "./generated/appliance-card-html.js";
import { handleUnitrendsTool } from "./tool-handler.js";
import { TOOL_DEFINITIONS } from "./tool.definitions.js";

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export interface UnitrendsCredentials {
  baseUrl: string;
  username: string;
  password: string;
  verifyTls?: boolean;
}

export function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return !["false", "0", "no", "off"].includes(value.trim().toLowerCase());
}

export function getCredentials(): UnitrendsCredentials | null {
  const baseUrl = process.env.UNITRENDS_BASE_URL;
  const username = process.env.UNITRENDS_USERNAME;
  const password = process.env.UNITRENDS_PASSWORD;
  if (!baseUrl || !username || !password) return null;
  return {
    baseUrl,
    username,
    password,
    verifyTls: parseBool(process.env.UNITRENDS_VERIFY_TLS, true),
  };
}

// ---------------------------------------------------------------------------
// Server factory — fresh server per request (stateless HTTP mode)
// ---------------------------------------------------------------------------

export function createMcpServer(credentialOverrides?: UnitrendsCredentials): Server {
  const server = new Server(
    {
      name: "unitrends-mcp",
      version: "0.0.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  );

  setServerRef(server);

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOL_DEFINITIONS };
  });

  // MCP Apps (SEP-1865): the ui:// appliance card is static HTML embedded at
  // build time (src/generated/appliance-card-html.ts), so it serves
  // identically from stdio and Node HTTP without touching the filesystem.
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [
        {
          uri: APPLIANCE_CARD_RESOURCE_URI,
          name: "Unitrends Appliance Card",
          description: "Interactive MCP Apps card rendering a Unitrends appliance's status",
          mimeType: MCP_APP_RESOURCE_MIME,
        },
      ],
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    if (uri !== APPLIANCE_CARD_RESOURCE_URI) {
      throw new Error(`Unknown resource: ${uri}`);
    }
    return {
      contents: [
        {
          uri,
          mimeType: MCP_APP_RESOURCE_MIME,
          // The card ships neutral; operators brand it at serve time via
          // MCP_BRAND_* env vars (no vars = HTML served unchanged).
          text: applyBrandInjection(APPLIANCE_CARD_HTML, resolveBrandFromEnv()),
        },
      ],
    };
  });

  // -------------------------------------------------------------------------
  // Tool call handler — logic lives in tool-handler.ts (testable in
  // isolation against a mocked UnitrendsClient).
  // -------------------------------------------------------------------------

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const creds = credentialOverrides ?? getCredentials();
    return handleUnitrendsTool(name, args, creds);
  });

  return server;
}
