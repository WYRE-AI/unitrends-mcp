/**
 * Declarative tool definitions for the Unitrends MCP server.
 *
 * Kept separate from mcp-server.ts so contract tests can import the
 * definitions without starting a transport. unitrends_get_appliance
 * additionally advertises the MCP Apps (SEP-1865) appliance card via `_meta`.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { APPLIANCE_CARD_META } from "./appliance-card.js";

export const TOOL_DEFINITIONS: Tool[] = [
  {
    name: "unitrends_list_appliances",
    description:
      "List Unitrends appliances visible to the connected MSP Console. Only returns data when pointed at the MSP Console; single-appliance deployments return an empty list.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "unitrends_get_appliance",
    description:
      "Get details for a single Unitrends appliance by its identifier. Only returns data when pointed at the MSP Console; single-appliance deployments do not expose this endpoint.",
    _meta: APPLIANCE_CARD_META,
    inputSchema: {
      type: "object",
      properties: {
        applianceId: {
          type: "string",
          description: "Appliance identifier",
        },
      },
      required: ["applianceId"],
    },
  },
  {
    name: "unitrends_list_assets",
    description:
      "List protected assets (machines / agents) on a Unitrends appliance. If applianceId is omitted and an MSP Console is in use, the user will be prompted to pick one.",
    inputSchema: {
      type: "object",
      properties: {
        applianceId: {
          type: "string",
          description: "Appliance identifier (optional — will elicit if omitted)",
        },
      },
    },
  },
  {
    name: "unitrends_get_asset",
    description: "Fetch details for a single protected asset.",
    inputSchema: {
      type: "object",
      properties: {
        applianceId: { type: "string", description: "Appliance identifier" },
        assetId: { type: "string", description: "Asset identifier" },
      },
      required: ["applianceId", "assetId"],
    },
  },
  {
    name: "unitrends_list_running_jobs",
    description: "List currently running and queued backup jobs.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "unitrends_list_job_history",
    description:
      "List historical backup jobs. If date range is omitted, the user will be prompted to choose a window.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string", description: "ISO 8601 start datetime (optional)" },
        until: { type: "string", description: "ISO 8601 end datetime (optional)" },
      },
    },
  },
  {
    name: "unitrends_list_recovery_points",
    description: "List recovery points (backups) available for an asset.",
    inputSchema: {
      type: "object",
      properties: {
        assetId: { type: "string", description: "Asset identifier" },
      },
      required: ["assetId"],
    },
  },
  {
    name: "unitrends_queue_restore",
    description:
      "Queue a restore from a recovery point. DESTRUCTIVE: writes data back into the target asset. Requires explicit confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        recoveryPointId: { type: "string", description: "Recovery point identifier to restore from" },
        targetAssetId: { type: "string", description: "Target asset identifier (defaults to source if omitted)" },
        targetPath: { type: "string", description: "Optional restore destination path" },
      },
      required: ["recoveryPointId"],
    },
  },
  {
    name: "unitrends_get_restore_status",
    description: "Check the status / progress of a queued restore.",
    inputSchema: {
      type: "object",
      properties: {
        restoreId: { type: "string", description: "Restore job identifier" },
      },
      required: ["restoreId"],
    },
  },
  {
    name: "unitrends_list_alerts",
    description: "List open alarms / alerts on the appliance.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "unitrends_get_success_rate",
    description:
      "Get RPO compliance / backup success-rate report. If date range is omitted, the user will be prompted.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string", description: "ISO 8601 start datetime (optional)" },
        until: { type: "string", description: "ISO 8601 end datetime (optional)" },
      },
    },
  },
];
