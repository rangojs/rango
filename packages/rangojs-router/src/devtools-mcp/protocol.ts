import type {
  DiagnosticTrace,
  DiagnosticValue,
} from "../router/diagnostics/types.js";
import type {
  BrowserNavigationEvent,
  BrowserNavigationKind,
} from "../router/diagnostics/browser-protocol.js";

export const RANGO_MCP_ENDPOINT = "/__rango/mcp";
export const RANGO_MCP_SCHEMA_VERSION = 1 as const;
export const RANGO_MCP_TOOL_SCHEMA_VERSION = 5 as const;
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
    routeMatching: boolean;
    discoveryStatus: boolean;
    compilationIssues: boolean;
    recentRequests: boolean;
    runtimeErrors: boolean;
    renderExplanation: boolean;
    revalidationExplanation: boolean;
    cacheTagExplanation: boolean;
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

export interface MatchRouteInput {
  url: string;
  routerId?: string;
}

export interface RouteCacheDeclaration {
  state: "none" | "disabled" | "configured";
  ttl: number | null;
  swr: number | null;
  tags: string[];
  tagsRuntime: boolean;
  keyRuntime: boolean;
  conditionRuntime: boolean;
  storeOverride: boolean;
  truncated: boolean;
}

export interface RouteLoaderDeclaration {
  id: string | null;
  cache: RouteCacheDeclaration;
  revalidationRuntime: boolean;
}

export interface RouteInterceptDeclaration {
  slot: string;
  targetRoute: string;
  selection: "always" | "runtime";
  middlewareCount: number;
  loaders: RouteLoaderDeclaration[];
  truncated: boolean;
}

export interface RouteSegmentDeclaration {
  id: string;
  type: "route" | "layout" | "parallel" | "cache";
  mountPath: string | null;
  cache: RouteCacheDeclaration;
  middlewareCount: number;
  revalidationRuntime: boolean;
  loading: boolean;
  transition: "none" | "static" | "runtime";
  loaders: RouteLoaderDeclaration[];
  parallelSlots: string[];
  intercepts: RouteInterceptDeclaration[];
  truncated: boolean;
}

export interface RouteStructureDeclaration {
  segments: RouteSegmentDeclaration[];
  ppr: {
    enabled: boolean;
    ttl: number | null;
    swr: number | null;
    tags: string[];
    tagsTruncated: boolean;
    runtimeConfig: boolean;
  };
  prerender: boolean;
  passthrough: boolean;
  responseType: string | null;
  truncated: boolean;
}

export interface MatchRouteSnapshot {
  schemaVersion: typeof RANGO_MCP_SCHEMA_VERSION;
  generation: number;
  capturedAt: string | null;
  stale: boolean;
  pathname: string;
  routerId: string | null;
  matched: boolean;
  route: {
    name: string | null;
    pattern: string;
    params: Record<string, string>;
    redirectTo: string | null;
    source: RouteSourceOwnership | null;
    search: Record<string, string> | null;
    structure: RouteStructureDeclaration | null;
  } | null;
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

export const BROWSER_NAVIGATION_KINDS: readonly BrowserNavigationKind[] = [
  "document",
  "navigate",
  "refresh",
  "popstate",
  "action",
];

export interface ListRequestsInput {
  routerId?: string;
  requestId?: string;
  navigationId?: string;
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
  navigationIds: string[];
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

export interface ListNavigationsInput {
  navigationId?: string;
  kind?: BrowserNavigationKind;
  completed?: boolean;
  since?: string;
  cursor?: string;
  limit?: number;
}

export interface NavigationSummary {
  navigationId: string;
  documentId: string;
  kind: BrowserNavigationKind;
  pathname: string;
  startedAt: string;
  updatedAt: string;
  completed: boolean;
  requestIds: string[];
  eventCount: number;
  truncated: boolean;
}

export interface NavigationsPageSnapshot {
  schemaVersion: typeof RANGO_MCP_SCHEMA_VERSION;
  navigations: NavigationSummary[];
  nextCursor: string | null;
  truncated: boolean;
}

export interface GetNavigationTraceInput {
  navigationId: string;
}

export interface NavigationTraceSnapshot {
  schemaVersion: typeof RANGO_MCP_SCHEMA_VERSION;
  navigationId: string;
  documentId: string;
  kind: BrowserNavigationKind;
  pathname: string;
  completed: boolean;
  requestIds: string[];
  events: BrowserNavigationEvent[];
  truncated: boolean;
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
  omittedTransactions: number;
}

export interface ExplainRenderInput {
  requestId: string;
}

export interface CacheScopeExplanation {
  segmentId: string | null;
  ownerType: string | null;
  kind: "explicit" | "inherited" | "implicit-shell" | "disabled" | "prerender";
  outcome: "hit" | "miss" | "stale" | "prerendered" | "bypass" | "error";
  reason: string | null;
  source: "runtime" | "prerender";
  storeKind: string | null;
  ttl: number | null;
  swr: number | null;
  freshForMs: number | null;
  tags: string[];
  identityDigest: string | null;
  backgroundRevalidationClaimed: boolean;
}

export interface LoaderCacheExplanation {
  outcome: "hit" | "stale" | "miss" | "bypass";
  reason: string | null;
  ttl: number | null;
  swr: number | null;
  backgroundRevalidationRequested: boolean;
}

export interface LoaderConsumerExplanation {
  kind: "dsl-client" | "handler" | "loader-dependency";
  consumerId: string | null;
  lane: "live" | "baked";
  boundary: "loading" | "consumer-suspense" | "none";
  containerValue: "request" | "capture-generation";
  nestedPromises: "none" | "request";
}

export interface LoaderRegistrationExplanation {
  registeredBy: string;
  segmentId: string;
  lane: "live" | "baked";
  boundary: "loading" | "none";
  dataCache: "configured" | "disabled" | "none";
}

export interface LoaderExplanation {
  loaderId: string;
  loaderName: string | null;
  registrations: LoaderRegistrationExplanation[];
  execution:
    | { outcome: "ran"; durationMs: number }
    | { outcome: "cached"; freshness: "fresh" | "stale" }
    | { outcome: "error"; durationMs: number; handledByBoundary: boolean }
    | { outcome: "unknown" };
  cacheDecisions: LoaderCacheExplanation[];
  consumers: LoaderConsumerExplanation[];
}

export interface HandlerExplanation {
  handlerId: string;
  outcome: "ran" | "error";
  durationMs: number;
}

export interface PprExplanationEvent {
  outcome: string;
  reason: string | null;
  freshness: string | null;
  source: string | null;
  backgroundCaptureRequested: boolean;
  navigationOnly: boolean;
  storeWrite: string | null;
}

export interface RenderExplanationSnapshot {
  schemaVersion: typeof RANGO_MCP_SCHEMA_VERSION;
  request: {
    requestId: string;
    transactionIds: string[];
    method: string | null;
    transport: RequestTransport | null;
    routeKey: string | null;
    routePattern: string | null;
  };
  renderCache: CacheScopeExplanation[];
  ppr: {
    document: PprExplanationEvent[];
    capture: PprExplanationEvent[];
    navigationReplay: PprExplanationEvent[];
  };
  loaders: LoaderExplanation[];
  handlers: HandlerExplanation[];
  renderStages: Array<{
    type: string;
    phase: string | null;
    durationMs: number | null;
  }>;
  errors: Array<{
    type: string;
    phase: string | null;
    error: DiagnosticValue;
  }>;
  truncated: boolean;
}

export interface ExplainRevalidationInput {
  requestId: string;
  transactionId?: string;
}

export interface ExplainCacheTagsInput {
  requestId: string;
  transactionId?: string;
}

export interface CacheTagReference {
  value: string;
  digest: string | null;
}

interface CacheTagOperationBase {
  transactionId: string;
  sequence: number;
  timestamp: number;
  tags: CacheTagReference[];
  tagCount: number;
  tagsTruncated: boolean;
}

export interface CacheTagObservationExplanation extends CacheTagOperationBase {
  kind: "observe";
  artifact:
    | "segment"
    | "loader"
    | "function"
    | "document"
    | "response-route"
    | "runtime-shell"
    | "build-shell";
  phase: "lookup" | "hit" | "stale" | "miss" | "write" | "capture" | "bypass";
  provenance: Array<
    "static-policy" | "dynamic-policy" | "runtime" | "stored" | "request-union"
  >;
  segmentId: string | null;
  identityDigest: string | null;
  outcome: string | null;
}

export interface CacheTagInvalidationExplanation extends CacheTagOperationBase {
  kind: "invalidate";
  verb: "updateTag" | "revalidateTag";
  outcome:
    | "requested"
    | "scheduled"
    | "completed"
    | "partial"
    | "failed"
    | "no-context"
    | "no-capable-store";
  capableStoreCount: number;
  incapableStoreCount: number;
}

export interface CacheTagExplanationSnapshot {
  schemaVersion: typeof RANGO_MCP_SCHEMA_VERSION;
  requestId: string;
  transactionId: string | null;
  operations: Array<
    CacheTagObservationExplanation | CacheTagInvalidationExplanation
  >;
  valuesExposed: true;
  storeState: "not-inspected";
  truncated: boolean;
}

export interface RevalidationDecisionExplanation {
  segmentId: string;
  segmentType: string;
  kind: "segment" | "loader";
  belongsToRoute: boolean;
  source: string;
  defaultShouldRevalidate: boolean;
  finalShouldRevalidate: boolean;
  reason: string;
  customRevalidators: number;
}

export interface RevalidationExplanationSnapshot {
  schemaVersion: typeof RANGO_MCP_SCHEMA_VERSION;
  requestId: string;
  transactionId: string;
  routeKey: string | null;
  method: string | null;
  isAction: boolean;
  actionId: string | null;
  stale: boolean;
  pathChanged: boolean;
  previousSearchNames: string[];
  nextSearchNames: string[];
  decisions: RevalidationDecisionExplanation[];
  truncated: boolean;
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
