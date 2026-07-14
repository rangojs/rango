import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import {
  RANGO_MCP_MAX_RESULT_BYTES,
  RANGO_MCP_SERVER_NAME,
  type GetRoutesInput,
} from "./protocol.js";
import type { RangoMcpSnapshotStore } from "./snapshot-store.js";

export interface RangoMcpToolHandlers {
  getProjectMetadata(): Promise<CallToolResult> | CallToolResult;
  getDiscoveryStatus(): Promise<CallToolResult> | CallToolResult;
  getRoutes(input: GetRoutesInput): Promise<CallToolResult> | CallToolResult;
}

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export function jsonToolResult(value: object): CallToolResult {
  const result: CallToolResult = {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
  if (
    Buffer.byteLength(JSON.stringify(result), "utf8") >
    RANGO_MCP_MAX_RESULT_BYTES
  ) {
    throw new Error("Rango MCP tool result exceeded its output limit");
  }
  return result;
}

export function createSnapshotToolHandlers(
  store: RangoMcpSnapshotStore,
): RangoMcpToolHandlers {
  return {
    getProjectMetadata: () => jsonToolResult(store.getProjectMetadata()),
    getDiscoveryStatus: () => jsonToolResult(store.getDiscoveryStatus()),
    getRoutes: (input) => jsonToolResult(store.getRoutes(input)),
  };
}

export function createRangoMcpServer(
  version: string,
  handlers: RangoMcpToolHandlers,
): McpServer {
  const server = new McpServer({ name: RANGO_MCP_SERVER_NAME, version });

  server.registerTool(
    "get_project_metadata",
    {
      description:
        "Get the running Rango project's root, preset, entry, versions, URL, and supported inspector capabilities.",
      annotations: READ_ONLY_ANNOTATIONS,
    },
    handlers.getProjectMetadata,
  );

  server.registerTool(
    "get_discovery_status",
    {
      description:
        "Get live route-discovery state, generation, freshness, counts, and the latest discovery error.",
      annotations: READ_ONLY_ANNOTATIONS,
    },
    handlers.getDiscoveryStatus,
  );

  server.registerTool(
    "get_routes",
    {
      description:
        "Get runtime-discovered Rango routes, including generated routes, names, patterns, source router files, search schemas, and trailing-slash behavior.",
      inputSchema: {
        routerId: z.string().min(1).optional(),
        cursor: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(1_000).optional(),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    handlers.getRoutes,
  );

  return server;
}
