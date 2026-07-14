import type {
  DiagnosticTrace,
  DiagnosticValue,
} from "../router/diagnostics/types.js";

export const RANGO_MCP_ENDPOINT = "/__rango/mcp";
export const RANGO_MCP_SCHEMA_VERSION = 1 as const;
export const RANGO_MCP_TOOL_SCHEMA_VERSION = 2 as const;
export const RANGO_MCP_SERVER_NAME = "Rango DevTools";
export const RANGO_MCP_MAX_RESULT_BYTES: number = 256 * 1024;

export type RangoPreset = "node" | "cloudflare" | "vercel";

export interface ProjectMetadataSnapshot {
  schemaVersion: typeof RANGO_MCP_SCHEMA_VERSION;
  toolSchemaVersion: typeof RANGO_MCP_TOOL_SCHEMA_VERSION;
  projectRoot: string;
  preset: RangoPreset;
  mode: string;
  entryFile: string | null;
  versions: {
    rango: string;
    node: string;
  };
  runtime: {
    instanceId: string;
    pid: number;
    startedAt: string;
    urls: string[];
    urlsTruncated: boolean;
  };
  routers: RouterRecord[];
  routersTruncated: boolean;
  capabilities: {
    routes: boolean;
    discoveryStatus: boolean;
    compilationIssues: boolean;
    recentRequests: boolean;
    runtimeErrors: boolean;
    sourceOwnership: boolean;
    browserState: boolean;
    logs: boolean;
  };
}

export type DiscoveryPhase = "starting" | "discovering" | "ready" | "error";

export interface DiscoveryStatusSnapshot {
  schemaVersion: typeof RANGO_MCP_SCHEMA_VERSION;
  phase: DiscoveryPhase;
  attempt: number;
  generation: number;
  stale: boolean;
  runtimeConvergence: "not-applicable" | "ready" | "pending" | "timeout";
  routerCount: number;
  routeCount: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: {
    message: string;
    at: string;
  } | null;
}

export type RouteKind = "static" | "parameterized" | "wildcard";

export interface RouteRecord {
  routerId: string;
  routerFile: string | null;
  name: string | null;
  pattern: string;
  kind: RouteKind;
  trailingSlash: string | null;
  search: Record<string, string> | null;
  truncated: boolean;
}

export interface RouterRecord {
  id: string;
  file: string | null;
}

export interface GetRoutesInput {
  routerId?: string;
  cursor?: string;
  limit?: number;
}

export interface RoutesPageSnapshot {
  schemaVersion: typeof RANGO_MCP_SCHEMA_VERSION;
  generation: number;
  capturedAt: string | null;
  stale: boolean;
  routerCount: number;
  totalRoutes: number;
  routes: RouteRecord[];
  nextCursor: string | null;
  truncated: boolean;
}

export interface RouteSourceOwnership {
  file: string;
  kind: "route";
  precision: "declaration-file" | "router-file";
}

export interface RouteOwnershipRecord {
  routerId: string;
  routeName: string | null;
  routePattern: string;
  source: RouteSourceOwnership | null;
}

export const REQUEST_TRANSPORTS: readonly [
  "document",
  "navigation",
  "prefetch",
  "action",
  "progressive-enhancement",
  "loader-fetch",
  "response-route",
  "reload",
] = [
  "document",
  "navigation",
  "prefetch",
  "action",
  "progressive-enhancement",
  "loader-fetch",
  "response-route",
  "reload",
];

export type RequestTransport = (typeof REQUEST_TRANSPORTS)[number];

export interface ListRequestsInput {
  routerId?: string;
  requestId?: string;
  transport?: RequestTransport;
  routePattern?: string;
  completed?: boolean;
  since?: string;
  cursor?: string;
  limit?: number;
}

export interface RequestSummary {
  requestId: string;
  routerId: string;
  clientCorrelationId: string | null;
  method: string | null;
  transport: RequestTransport | null;
  routeKey: string | null;
  routePattern: string | null;
  status: number | null;
  startedAt: string;
  updatedAt: string;
  completed: boolean;
  errorCount: number;
  eventCount: number;
  truncated: boolean;
  droppedEvents: number;
  source: RouteSourceOwnership | null;
}

export interface DiagnosticBridgeStats {
  acceptedBatches: number;
  rejectedBatches: number;
  duplicateBatches: number;
  bridgeDroppedEvents: number;
  hubDroppedEvents: number;
}

export interface RequestsPageSnapshot {
  schemaVersion: typeof RANGO_MCP_SCHEMA_VERSION;
  requests: RequestSummary[];
  nextCursor: string | null;
  truncated: boolean;
  stats: DiagnosticBridgeStats;
}

export interface GetRequestTraceInput {
  requestId: string;
}

export interface RequestTraceSnapshot {
  schemaVersion: typeof RANGO_MCP_SCHEMA_VERSION;
  trace: DiagnosticTrace;
  source: RouteSourceOwnership | null;
  outputTruncated: boolean;
  omittedEvents: number;
}

export interface GetErrorsInput {
  requestId?: string;
  routerId?: string;
  since?: string;
  cursor?: string;
  limit?: number;
}

export interface RuntimeErrorRecord {
  id: string;
  requestId: string;
  transactionId: string;
  routerId: string;
  routeKey: string | null;
  type: string;
  phase: string | null;
  timestamp: number;
  receivedAt: string;
  error: DiagnosticValue;
  source: RouteSourceOwnership | null;
}

export interface ErrorsPageSnapshot {
  schemaVersion: typeof RANGO_MCP_SCHEMA_VERSION;
  errors: RuntimeErrorRecord[];
  nextCursor: string | null;
  truncated: boolean;
}

export interface GetCompilationIssuesInput {
  severity?: "error" | "warning";
  since?: string;
  cursor?: string;
  limit?: number;
}

export interface CompilationIssueRecord {
  id: string;
  severity: "error" | "warning";
  message: string;
  plugin: string | null;
  file: string | null;
  line: number | null;
  column: number | null;
  frame: string | null;
  environment: string | null;
  freshness: "current" | "recent";
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
}

export interface CompilationIssuesPageSnapshot {
  schemaVersion: typeof RANGO_MCP_SCHEMA_VERSION;
  issues: CompilationIssueRecord[];
  nextCursor: string | null;
  truncated: boolean;
  capture: {
    structuredErrors: boolean;
    warnings: "recent-only";
  };
  droppedIssues: number;
}

export function serializedToolResultBytes(value: object): number {
  return Buffer.byteLength(
    JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
      structuredContent: value,
    }),
    "utf8",
  );
}
