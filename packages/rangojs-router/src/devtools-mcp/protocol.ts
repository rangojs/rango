export const RANGO_MCP_ENDPOINT = "/__rango/mcp";
export const RANGO_MCP_SCHEMA_VERSION = 1 as const;
export const RANGO_MCP_SERVER_NAME = "Rango DevTools";
export const RANGO_MCP_MAX_RESULT_BYTES: number = 256 * 1024;

export type RangoPreset = "node" | "cloudflare" | "vercel";

export interface ProjectMetadataSnapshot {
  schemaVersion: typeof RANGO_MCP_SCHEMA_VERSION;
  toolSchemaVersion: typeof RANGO_MCP_SCHEMA_VERSION;
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
    recentRequests: boolean;
    runtimeErrors: boolean;
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
