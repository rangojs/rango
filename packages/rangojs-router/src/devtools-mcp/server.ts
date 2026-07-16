import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import {
  RANGO_MCP_MAX_RESULT_BYTES,
  RANGO_MCP_SERVER_NAME,
  REQUEST_TRANSPORTS,
  type ExplainCacheTagsInput,
  type ExplainRenderInput,
  type ExplainRevalidationInput,
  type GetCompilationIssuesInput,
  type GetErrorsInput,
  type GetRequestTraceInput,
  type GetRoutesInput,
  type ListRequestsInput,
} from "./protocol.js";
import type { RangoMcpDiagnosticStore } from "./diagnostic-store.js";
import type { RangoMcpSnapshotStore } from "./snapshot-store.js";

const MAX_CURSOR_LENGTH = 16_384;

export interface RangoMcpToolHandlers {
  getProjectMetadata(): Promise<CallToolResult> | CallToolResult;
  getDiscoveryStatus(): Promise<CallToolResult> | CallToolResult;
  getRoutes(input: GetRoutesInput): Promise<CallToolResult> | CallToolResult;
  getCompilationIssues(
    input: GetCompilationIssuesInput,
  ): Promise<CallToolResult> | CallToolResult;
  getErrors(input: GetErrorsInput): Promise<CallToolResult> | CallToolResult;
  listRequests(
    input: ListRequestsInput,
  ): Promise<CallToolResult> | CallToolResult;
  getRequestTrace(
    input: GetRequestTraceInput,
  ): Promise<CallToolResult> | CallToolResult;
  explainRender(
    input: ExplainRenderInput,
  ): Promise<CallToolResult> | CallToolResult;
  explainCacheTags(
    input: ExplainCacheTagsInput,
  ): Promise<CallToolResult> | CallToolResult;
  explainRevalidation(
    input: ExplainRevalidationInput,
  ): Promise<CallToolResult> | CallToolResult;
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
  diagnostics: RangoMcpDiagnosticStore,
): RangoMcpToolHandlers {
  return {
    getProjectMetadata: () => jsonToolResult(store.getProjectMetadata()),
    getDiscoveryStatus: () => jsonToolResult(store.getDiscoveryStatus()),
    getRoutes: (input) => jsonToolResult(store.getRoutes(input)),
    getCompilationIssues: (input) =>
      jsonToolResult(diagnostics.getCompilationIssues(input)),
    getErrors: (input) => jsonToolResult(diagnostics.getErrors(input)),
    listRequests: (input) => jsonToolResult(diagnostics.listRequests(input)),
    getRequestTrace: (input) =>
      jsonToolResult(diagnostics.getRequestTrace(input)),
    explainRender: (input) => jsonToolResult(diagnostics.explainRender(input)),
    explainCacheTags: (input) =>
      jsonToolResult(diagnostics.explainCacheTags(input)),
    explainRevalidation: (input) =>
      jsonToolResult(diagnostics.explainRevalidation(input)),
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
        cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).optional(),
        limit: z.number().int().min(1).max(1_000).optional(),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    handlers.getRoutes,
  );

  server.registerTool(
    "get_compilation_issues",
    {
      description:
        "Get bounded current Vite transform errors and recent compiler warnings with sanitized source locations.",
      inputSchema: {
        severity: z.enum(["error", "warning"]).optional(),
        since: z.string().min(1).optional(),
        cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    handlers.getCompilationIssues,
  );

  server.registerTool(
    "list_requests",
    {
      description:
        "List bounded recent Rango request summaries so one browser request can be selected without ambiguity.",
      inputSchema: {
        routerId: z.string().min(1).max(512).optional(),
        requestId: z.string().min(1).max(128).optional(),
        transport: z.enum(REQUEST_TRANSPORTS).optional(),
        routePattern: z.string().min(1).max(4_096).optional(),
        completed: z.boolean().optional(),
        since: z.string().min(1).optional(),
        cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    handlers.listRequests,
  );

  server.registerTool(
    "get_request_trace",
    {
      description:
        "Get the bounded structured framework trace and route source ownership for one exact server request ID.",
      inputSchema: {
        requestId: z.string().min(1).max(128),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    handlers.getRequestTrace,
  );

  server.registerTool(
    "get_errors",
    {
      description:
        "Get bounded sanitized Rango runtime errors retained by request ID, router, or receipt time.",
      inputSchema: {
        requestId: z.string().min(1).max(128).optional(),
        routerId: z.string().min(1).max(512).optional(),
        since: z.string().min(1).optional(),
        cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    handlers.getErrors,
  );

  server.registerTool(
    "explain_render",
    {
      description:
        "Explain segment cache, PPR, handler, and loader execution and visible generations for one retained request.",
      inputSchema: {
        requestId: z.string().min(1).max(128),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    handlers.explainRender,
  );

  server.registerTool(
    "explain_cache_tags",
    {
      description:
        "Explain exact bounded cache-tag attachment and invalidation activity observed for one retained request without reading or mutating cache entries.",
      inputSchema: {
        requestId: z.string().min(1).max(128),
        transactionId: z.string().min(1).max(128).optional(),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    handlers.explainCacheTags,
  );

  server.registerTool(
    "explain_revalidation",
    {
      description:
        "Explain the separate segment and loader recomputation decisions for one retained request, optionally selecting one of its transactions.",
      inputSchema: {
        requestId: z.string().min(1).max(128),
        transactionId: z.string().min(1).max(128).optional(),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    handlers.explainRevalidation,
  );

  return server;
}
