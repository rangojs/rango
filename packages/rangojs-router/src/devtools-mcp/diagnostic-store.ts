import { isAbsolute, relative } from "node:path";
import {
  RANGO_DIAGNOSTIC_BRIDGE_VERSION,
  RANGO_DIAGNOSTIC_MAX_BATCH_BYTES,
  RANGO_DIAGNOSTIC_MAX_BATCH_EVENTS,
  RANGO_DIAGNOSTIC_MAX_DROP_REQUESTS,
  type DiagnosticBridgeBatch,
} from "../router/diagnostics/bridge-protocol.js";
import { DiagnosticHub } from "../router/diagnostics/hub.js";
import {
  isDiagnosticCredentialKey,
  sanitizeDiagnosticText,
} from "../router/diagnostics/redaction.js";
import type {
  DiagnosticEvent,
  DiagnosticEventInput,
  DiagnosticTrace,
  DiagnosticValue,
} from "../router/diagnostics/types.js";
import {
  RANGO_BROWSER_NAVIGATION_VERSION,
  type BrowserNavigationEvent,
  type BrowserNavigationKind,
  type BrowserNavigationPhase,
  type BrowserNavigationRequestRole,
} from "../router/diagnostics/browser-protocol.js";
import {
  RANGO_MCP_MAX_RESULT_BYTES,
  RANGO_MCP_SCHEMA_VERSION,
  REQUEST_TRANSPORTS,
  serializedToolResultBytes,
  type CompilationIssueRecord,
  type CompilationIssuesPageSnapshot,
  type DiagnosticBridgeStats,
  type CacheScopeExplanation,
  type CacheTagExplanationSnapshot,
  type CacheTagInvalidationExplanation,
  type CacheTagObservationExplanation,
  type ErrorsPageSnapshot,
  type ExplainCacheTagsInput,
  type ExplainRenderInput,
  type ExplainRevalidationInput,
  type GetCompilationIssuesInput,
  type GetErrorsInput,
  type GetRequestTraceInput,
  type GetNavigationTraceInput,
  type HandlerExplanation,
  type LoaderCacheExplanation,
  type LoaderConsumerExplanation,
  type LoaderExplanation,
  type ListRequestsInput,
  type ListNavigationsInput,
  type NavigationsPageSnapshot,
  type NavigationSummary,
  type NavigationTraceSnapshot,
  type PprExplanationEvent,
  type RenderExplanationSnapshot,
  type RevalidationDecisionExplanation,
  type RevalidationExplanationSnapshot,
  type RequestSummary,
  type RequestsPageSnapshot,
  type RequestTraceSnapshot,
  type RequestTransport,
  type RouteSourceOwnership,
  type RuntimeErrorRecord,
} from "./protocol.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_REALMS = 64;
const MAX_COMPILATION_ISSUES = 100;
const MAX_RECENT_ISSUE_AGE_MS = 5 * 60_000;
const MAX_EXPLANATION_ITEMS = 64;
const MAX_TRACE_TRANSACTION_IDS = 128;
const MAX_NAVIGATIONS = 100;
const MAX_NAVIGATION_EVENTS = 128;
const MAX_NAVIGATION_REQUESTS = 64;
const MAX_REORDERED_BATCHES = 256;
const REORDERED_BATCH_GAP_TIMEOUT_MS = 250;

interface StoreCursor {
  instanceId: string;
  kind: "requests" | "navigations" | "errors" | "compilation";
  revision: number;
  filter: string;
  offset: number;
}

interface RequestReceipt {
  firstSeenAt: number;
  lastSeenAt: number;
  eventReceivedAt: Map<number, number>;
}

interface RealmBatchState {
  nextSequence: number;
  lastObservedAt: number;
  pendingBatches: Map<number, PendingBridgeBatch>;
  gapTimer?: ReturnType<typeof setTimeout>;
}

interface PendingBridgeBatch {
  events: DiagnosticEventInput[];
  droppedEvents: number;
  droppedEventsByRequest: Array<{
    requestId: string;
    droppedEvents: number;
  }>;
  observedAt: number;
  receivedAt: number;
}

interface RetainedNavigation {
  navigationId: string;
  documentId: string;
  kind: BrowserNavigationKind;
  pathname: string;
  firstSeenAt: number;
  lastSeenAt: number;
  completed: boolean;
  requestIds: Set<string>;
  events: BrowserNavigationEvent[];
  truncated: boolean;
}

export interface DiagnosticStoreOptions {
  instanceId: string;
  projectRoot: string;
  getRouteSource(
    routerId: string,
    routeKey: string | null,
    routePattern: string | null,
  ): RouteSourceOwnership | null;
}

export interface CompilationIssueInput {
  severity: "error" | "warning";
  message: unknown;
  plugin?: unknown;
  file?: unknown;
  line?: unknown;
  column?: unknown;
  frame?: unknown;
  environment?: unknown;
  freshness: "current" | "recent";
  timestamp?: number;
}

export interface RangoMcpDiagnosticStore {
  ingestBridgeBatch(
    value: unknown,
    observedAt?: number,
    receivedAt?: number,
  ): boolean;
  ingestBrowserNavigationEvent(value: unknown, receivedAt?: number): boolean;
  listRequests(input?: ListRequestsInput): RequestsPageSnapshot;
  listNavigations(input?: ListNavigationsInput): NavigationsPageSnapshot;
  getNavigationTrace(input: GetNavigationTraceInput): NavigationTraceSnapshot;
  getRequestTrace(input: GetRequestTraceInput): RequestTraceSnapshot;
  explainRender(input: ExplainRenderInput): RenderExplanationSnapshot;
  explainCacheTags(input: ExplainCacheTagsInput): CacheTagExplanationSnapshot;
  explainRevalidation(
    input: ExplainRevalidationInput,
  ): RevalidationExplanationSnapshot;
  getErrors(input?: GetErrorsInput): ErrorsPageSnapshot;
  recordCompilationIssue(input: CompilationIssueInput): void;
  resolveCompilationFiles(files: string[], environment?: string): void;
  setStructuredErrorCapture(available: boolean): void;
  getCompilationIssues(
    input?: GetCompilationIssuesInput,
  ): CompilationIssuesPageSnapshot;
}

function encodeCursor(cursor: StoreCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): StoreCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<StoreCursor>;
    if (
      typeof parsed.instanceId !== "string" ||
      (parsed.kind !== "requests" &&
        parsed.kind !== "navigations" &&
        parsed.kind !== "errors" &&
        parsed.kind !== "compilation") ||
      !Number.isSafeInteger(parsed.revision) ||
      typeof parsed.filter !== "string" ||
      !Number.isSafeInteger(parsed.offset) ||
      (parsed.offset ?? -1) < 0
    ) {
      throw new Error("invalid cursor fields");
    }
    return parsed as StoreCursor;
  } catch {
    throw new Error("Invalid diagnostic cursor");
  }
}

function parseSince(value: string | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("Invalid since timestamp");
  return timestamp;
}

function pageLimit(value: number | undefined): number {
  return Math.min(Math.max(value ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

function pageWithinResultLimit<T>(
  items: readonly T[],
  offset: number,
  limit: number,
  createProbe: (page: T[], nextOffset: number) => object,
): { page: T[]; stoppedForSize: boolean } {
  const available = items.slice(offset, offset + limit);
  if (
    serializedToolResultBytes(
      createProbe(available, offset + available.length),
    ) <= RANGO_MCP_MAX_RESULT_BYTES
  ) {
    return { page: available, stoppedForSize: false };
  }
  let low = 0;
  let high = available.length;
  let best = 0;
  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    const candidate = available.slice(0, length);
    if (
      serializedToolResultBytes(createProbe(candidate, offset + length)) <=
      RANGO_MCP_MAX_RESULT_BYTES
    ) {
      best = length;
      low = length + 1;
    } else {
      high = length - 1;
    }
  }
  if (available.length > 0 && best === 0) {
    throw new Error("A diagnostic record exceeded the MCP output limit");
  }
  return { page: available.slice(0, best), stoppedForSize: true };
}

function safeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : null;
}

function sanitizeValue(value: unknown, depth: number = 0): DiagnosticValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") return sanitizeDiagnosticText(value);
  if (depth >= 3) return "[truncated]";
  if (Array.isArray(value)) {
    return value.slice(0, 128).map((item) => sanitizeValue(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const result: Record<string, DiagnosticValue> = {};
    let count = 0;
    for (const [key, item] of Object.entries(value)) {
      result[sanitizeDiagnosticText(key, 256)] = isDiagnosticCredentialKey(key)
        ? "[redacted]"
        : sanitizeValue(item, depth + 1);
      if (++count === 64) break;
    }
    return result;
  }
  return "[unsupported]";
}

function sanitizeBridgeEvent(value: unknown): DiagnosticEventInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Partial<DiagnosticEvent>;
  if (
    event.schemaVersion !== 1 ||
    !Number.isSafeInteger(event.sequence) ||
    typeof event.timestamp !== "number" ||
    !Number.isFinite(event.timestamp) ||
    typeof event.type !== "string" ||
    typeof event.requestId !== "string" ||
    typeof event.transactionId !== "string" ||
    typeof event.routerId !== "string" ||
    !event.data ||
    typeof event.data !== "object" ||
    Array.isArray(event.data)
  ) {
    return null;
  }
  return {
    type: sanitizeDiagnosticText(event.type, 256),
    timestamp: event.timestamp,
    requestId: sanitizeDiagnosticText(event.requestId, 128),
    transactionId: sanitizeDiagnosticText(event.transactionId, 128),
    ...(typeof event.clientCorrelationId === "string"
      ? {
          clientCorrelationId: sanitizeDiagnosticText(
            event.clientCorrelationId,
            128,
          ),
        }
      : {}),
    routerId: sanitizeDiagnosticText(event.routerId, 512),
    ...(typeof event.routeKey === "string"
      ? { routeKey: sanitizeDiagnosticText(event.routeKey, 1_024) }
      : {}),
    ...(typeof event.segmentId === "string"
      ? { segmentId: sanitizeDiagnosticText(event.segmentId, 1_024) }
      : {}),
    data: sanitizeValue(event.data) as Record<string, DiagnosticValue>,
  };
}

const NAVIGATION_ID_PATTERN =
  /^nav-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DOCUMENT_ID_PATTERN =
  /^doc-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REQUEST_ID_PATTERN =
  /^req-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const NAVIGATION_KINDS = new Set<BrowserNavigationKind>([
  "document",
  "navigate",
  "refresh",
  "popstate",
  "action",
]);
const NAVIGATION_PHASES = new Set<BrowserNavigationPhase>([
  "started",
  "request-linked",
  "committed",
  "aborted",
  "failed",
]);
const NAVIGATION_ROLES = new Set<BrowserNavigationRequestRole>([
  "document",
  "navigation",
  "prefetch-source",
  "action",
  "revalidation",
]);

function sanitizeBrowserNavigationEvent(
  value: unknown,
): BrowserNavigationEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Partial<BrowserNavigationEvent>;
  if (
    event.version !== RANGO_BROWSER_NAVIGATION_VERSION ||
    !Number.isSafeInteger(event.sequence) ||
    (event.sequence ?? 0) <= 0 ||
    typeof event.documentId !== "string" ||
    !DOCUMENT_ID_PATTERN.test(event.documentId) ||
    typeof event.navigationId !== "string" ||
    !NAVIGATION_ID_PATTERN.test(event.navigationId) ||
    typeof event.kind !== "string" ||
    !NAVIGATION_KINDS.has(event.kind as BrowserNavigationKind) ||
    typeof event.phase !== "string" ||
    !NAVIGATION_PHASES.has(event.phase as BrowserNavigationPhase) ||
    typeof event.pathname !== "string" ||
    !event.pathname.startsWith("/") ||
    Buffer.byteLength(event.pathname, "utf8") > 4_096 ||
    (event.requestId !== undefined &&
      (typeof event.requestId !== "string" ||
        !REQUEST_ID_PATTERN.test(event.requestId))) ||
    (event.role !== undefined &&
      (typeof event.role !== "string" ||
        !NAVIGATION_ROLES.has(event.role as BrowserNavigationRequestRole))) ||
    (event.phase === "request-linked" && (!event.requestId || !event.role)) ||
    (event.phase !== "request-linked" &&
      (event.requestId !== undefined || event.role !== undefined))
  ) {
    return null;
  }
  return {
    version: RANGO_BROWSER_NAVIGATION_VERSION,
    sequence: event.sequence!,
    documentId: event.documentId,
    navigationId: event.navigationId,
    kind: event.kind as BrowserNavigationKind,
    phase: event.phase as BrowserNavigationPhase,
    pathname: sanitizeDiagnosticText(event.pathname, 4_096),
    ...(event.requestId ? { requestId: event.requestId } : {}),
    ...(event.role ? { role: event.role as BrowserNavigationRequestRole } : {}),
  };
}

function isRequestTransport(value: unknown): value is RequestTransport {
  return REQUEST_TRANSPORTS.includes(value as RequestTransport);
}

function isErrorEvent(event: DiagnosticEvent): boolean {
  return (
    event.type === "request.failed" ||
    event.type === "match.failed" ||
    event.type === "phase.failed" ||
    event.type === "error.reported" ||
    event.type === "render.stage:error"
  );
}

function classifiedEvent(trace: DiagnosticTrace): DiagnosticEvent | undefined {
  return trace.events.find((event) => event.type === "request.classified");
}

function routePattern(event: DiagnosticEvent | undefined): string | null {
  const value = event?.data.routePattern;
  return typeof value === "string" ? value : null;
}

function diagnosticString(
  value: DiagnosticValue | undefined,
  maxBytes: number = 256,
): string | null {
  return typeof value === "string"
    ? sanitizeDiagnosticText(value, maxBytes)
    : null;
}

function diagnosticNumber(value: DiagnosticValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function diagnosticBoolean(value: DiagnosticValue | undefined): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function diagnosticStrings(
  value: DiagnosticValue | undefined,
  limit: number = 8,
  maxBytes: number = 128,
): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .slice(0, limit)
        .map((item) => sanitizeDiagnosticText(item, maxBytes))
    : [];
}

function diagnosticTagValues(value: DiagnosticValue | undefined): {
  values: string[];
  valid: boolean;
  truncated: boolean;
} {
  if (!Array.isArray(value)) {
    return { values: [], valid: false, truncated: false };
  }
  const raw = value.filter((item): item is string => typeof item === "string");
  const retained = raw.slice(0, 16);
  return {
    values: retained.map((item) => sanitizeDiagnosticText(item, 256)),
    valid: raw.length === value.length,
    truncated:
      raw.length > retained.length ||
      retained.some((item) => Buffer.byteLength(item, "utf8") > 256),
  };
}

function diagnosticTagDigests(value: DiagnosticValue | undefined): {
  values: Array<string | null>;
  valid: boolean;
  truncated: boolean;
} {
  if (!Array.isArray(value)) {
    return { values: [], valid: false, truncated: false };
  }
  const valid = value.every(
    (item): item is string | null => item === null || typeof item === "string",
  );
  const retained = value.slice(0, 16);
  return {
    values: retained.map((item) =>
      typeof item === "string" ? sanitizeDiagnosticText(item, 128) : null,
    ),
    valid,
    truncated:
      value.length > retained.length ||
      retained.some(
        (item) =>
          typeof item === "string" && Buffer.byteLength(item, "utf8") > 128,
      ),
  };
}

function diagnosticCount(value: DiagnosticValue | undefined): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : null;
}

const CACHE_TAG_ARTIFACTS = new Set<CacheTagObservationExplanation["artifact"]>(
  [
    "segment",
    "loader",
    "function",
    "document",
    "response-route",
    "runtime-shell",
    "build-shell",
  ],
);

const CACHE_TAG_PHASES = new Set<CacheTagObservationExplanation["phase"]>([
  "lookup",
  "hit",
  "stale",
  "miss",
  "write",
  "capture",
  "bypass",
]);

const CACHE_TAG_PROVENANCE = new Set<
  CacheTagObservationExplanation["provenance"][number]
>(["static-policy", "dynamic-policy", "runtime", "stored", "request-union"]);

function diagnosticCacheTagProvenance(value: DiagnosticValue | undefined): {
  values: CacheTagObservationExplanation["provenance"];
  valid: boolean;
  truncated: boolean;
} {
  if (!Array.isArray(value)) {
    return { values: [], valid: false, truncated: false };
  }
  const raw = value.filter((item): item is string => typeof item === "string");
  const retained = raw.slice(0, 8);
  const sanitized = retained.map((item) => sanitizeDiagnosticText(item, 128));
  const values = sanitized.filter(
    (item): item is CacheTagObservationExplanation["provenance"][number] =>
      CACHE_TAG_PROVENANCE.has(
        item as CacheTagObservationExplanation["provenance"][number],
      ),
  );
  return {
    values,
    valid: raw.length === value.length && values.length === sanitized.length,
    truncated:
      raw.length > retained.length ||
      retained.some((item) => Buffer.byteLength(item, "utf8") > 128),
  };
}

const CACHE_TAG_INVALIDATION_OUTCOMES = new Set<
  CacheTagInvalidationExplanation["outcome"]
>([
  "requested",
  "scheduled",
  "completed",
  "partial",
  "failed",
  "no-context",
  "no-capable-store",
]);

function projectCacheTagExplanation(
  trace: DiagnosticTrace,
  transactionId?: string,
): CacheTagExplanationSnapshot {
  if (transactionId && !trace.transactionIds.includes(transactionId)) {
    throw new Error(
      `No retained transaction ${transactionId} for request ${trace.requestId}`,
    );
  }
  const operations: CacheTagExplanationSnapshot["operations"] = [];
  let truncated = trace.truncated || trace.droppedEvents > 0;
  for (const event of trace.events) {
    if (event.type !== "cache.tags") continue;
    if (transactionId && event.transactionId !== transactionId) continue;
    if (operations.length >= MAX_EXPLANATION_ITEMS) {
      truncated = true;
      break;
    }
    const kind = diagnosticString(event.data.kind);
    const tagValues = diagnosticTagValues(event.data.tags);
    const tagDigests = diagnosticTagDigests(event.data.tagDigests);
    const tagCount = diagnosticCount(event.data.tagCount);
    if (
      !tagValues.valid ||
      !tagDigests.valid ||
      tagCount === null ||
      tagCount === 0 ||
      tagCount < tagValues.values.length ||
      tagDigests.values.length !== tagValues.values.length ||
      typeof event.data.tagsTruncated !== "boolean"
    ) {
      truncated = true;
      continue;
    }
    const tagsTruncated =
      diagnosticBoolean(event.data.tagsTruncated) === true ||
      tagValues.truncated ||
      tagDigests.truncated ||
      tagValues.values.length < tagCount;
    const base = {
      transactionId: event.transactionId,
      sequence: event.sequence,
      timestamp: event.timestamp,
      tags: tagValues.values.map((value, index) => ({
        value,
        digest: tagDigests.values[index] ?? null,
      })),
      tagCount,
      tagsTruncated,
    };
    truncated ||= tagsTruncated;
    if (kind === "observe") {
      const artifact = diagnosticString(event.data.artifact);
      const phase = diagnosticString(event.data.phase);
      const parsedProvenance = diagnosticCacheTagProvenance(
        event.data.provenance,
      );
      const provenance = parsedProvenance.values;
      if (
        !CACHE_TAG_ARTIFACTS.has(
          artifact as CacheTagObservationExplanation["artifact"],
        ) ||
        !CACHE_TAG_PHASES.has(
          phase as CacheTagObservationExplanation["phase"],
        ) ||
        provenance.length === 0 ||
        !parsedProvenance.valid ||
        parsedProvenance.truncated
      ) {
        truncated = true;
        continue;
      }
      operations.push({
        ...base,
        kind: "observe",
        artifact: artifact as CacheTagObservationExplanation["artifact"],
        phase: phase as CacheTagObservationExplanation["phase"],
        provenance,
        segmentId: event.segmentId ?? null,
        identityDigest: diagnosticString(event.data.identityDigest),
        outcome: diagnosticString(event.data.outcome),
      });
      continue;
    }
    if (kind === "invalidate") {
      const verb = diagnosticString(event.data.verb);
      const outcome = diagnosticString(event.data.outcome);
      const capableStoreCount = diagnosticCount(event.data.capableStoreCount);
      const incapableStoreCount = diagnosticCount(
        event.data.incapableStoreCount,
      );
      if (
        (verb !== "updateTag" && verb !== "revalidateTag") ||
        !CACHE_TAG_INVALIDATION_OUTCOMES.has(
          outcome as CacheTagInvalidationExplanation["outcome"],
        ) ||
        capableStoreCount === null ||
        incapableStoreCount === null
      ) {
        truncated = true;
        continue;
      }
      operations.push({
        ...base,
        kind: "invalidate",
        verb,
        outcome: outcome as CacheTagInvalidationExplanation["outcome"],
        capableStoreCount,
        incapableStoreCount,
      });
      continue;
    }
    truncated = true;
  }
  const snapshot: CacheTagExplanationSnapshot = {
    schemaVersion: RANGO_MCP_SCHEMA_VERSION,
    requestId: trace.requestId,
    transactionId: transactionId ?? null,
    operations,
    valuesExposed: true,
    storeState: "not-inspected",
    truncated,
  };
  while (
    snapshot.operations.length > 0 &&
    serializedToolResultBytes(snapshot) > RANGO_MCP_MAX_RESULT_BYTES
  ) {
    snapshot.operations.pop();
    snapshot.truncated = true;
  }
  return snapshot;
}

function diagnosticStringsWithTruncation(value: DiagnosticValue | undefined): {
  values: string[];
  truncated: boolean;
} {
  if (!Array.isArray(value)) return { values: [], truncated: value != null };
  const strings = value.filter(
    (item): item is string => typeof item === "string",
  );
  return {
    values: diagnosticStrings(value),
    truncated: strings.length !== value.length || strings.length > 8,
  };
}

function diagnosticErrorSummary(value: DiagnosticValue): DiagnosticValue {
  if (typeof value === "string") return sanitizeDiagnosticText(value, 512);
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const name = diagnosticString(value.name);
  const message = diagnosticString(value.message);
  const stack = diagnosticString(value.stack, 2_048);
  return {
    ...(name ? { name } : {}),
    ...(message ? { message } : {}),
    ...(stack ? { stack } : {}),
  };
}

function loaderNameFromId(loaderId: string): string | null {
  const separator = loaderId.lastIndexOf("#");
  return separator >= 0 && separator < loaderId.length - 1
    ? loaderId.slice(separator + 1)
    : null;
}

function pprExplanation(event: DiagnosticEvent): PprExplanationEvent {
  const rawOutcome = diagnosticString(event.data.outcome) ?? "unknown";
  return {
    outcome:
      event.type === "ppr.capture" && rawOutcome === "stored"
        ? "captured"
        : rawOutcome,
    reason: diagnosticString(event.data.reason),
    freshness: diagnosticString(event.data.freshness),
    source: diagnosticString(event.data.source),
    backgroundCaptureRequested:
      diagnosticBoolean(event.data.backgroundCaptureRequested) ?? false,
    navigationOnly: diagnosticBoolean(event.data.navigationOnly) ?? false,
    storeWrite: diagnosticString(event.data.storeWrite),
  };
}

interface MutableLoaderExplanation {
  value: LoaderExplanation;
  completedDuration: number | null;
  failedDuration: number | null;
  failedHandledByBoundary: boolean;
}

function projectRenderExplanation(
  trace: DiagnosticTrace,
): RenderExplanationSnapshot {
  const classified = classifiedEvent(trace);
  const started = trace.events.find(
    (event) => event.type === "request.started",
  );
  const transport = classified?.data.transport;
  const renderCache: CacheScopeExplanation[] = [];
  const ppr: RenderExplanationSnapshot["ppr"] = {
    document: [],
    capture: [],
    navigationReplay: [],
  };
  const loaders = new Map<string, MutableLoaderExplanation>();
  const loadersBySegment = new Map<string, MutableLoaderExplanation>();
  const handlers: HandlerExplanation[] = [];
  const renderStages: RenderExplanationSnapshot["renderStages"] = [];
  const errors: RenderExplanationSnapshot["errors"] = [];
  let explanationItems = 0;
  let truncated = trace.truncated || trace.droppedEvents > 0;

  const claimItem = (): boolean => {
    if (explanationItems >= MAX_EXPLANATION_ITEMS) {
      truncated = true;
      return false;
    }
    explanationItems++;
    return true;
  };
  const loader = (loaderId: string): MutableLoaderExplanation | null => {
    const existing = loaders.get(loaderId);
    if (existing) return existing;
    if (!claimItem()) return null;
    const created: MutableLoaderExplanation = {
      value: {
        loaderId,
        loaderName: loaderNameFromId(loaderId),
        registrations: [],
        execution: { outcome: "unknown" },
        cacheDecisions: [],
        consumers: [],
      },
      completedDuration: null,
      failedDuration: null,
      failedHandledByBoundary: false,
    };
    loaders.set(loaderId, created);
    return created;
  };

  for (const event of trace.events) {
    if (event.type === "cache.scope") {
      const kind = diagnosticString(event.data.kind);
      const outcome = diagnosticString(event.data.outcome);
      const source = diagnosticString(event.data.source);
      const tags = diagnosticStrings(event.data.tags);
      if (
        Array.isArray(event.data.tags) &&
        event.data.tags.length > tags.length
      ) {
        truncated = true;
      }
      if (
        (kind === "explicit" ||
          kind === "inherited" ||
          kind === "implicit-shell" ||
          kind === "disabled" ||
          kind === "prerender") &&
        (outcome === "hit" ||
          outcome === "miss" ||
          outcome === "stale" ||
          outcome === "prerendered" ||
          outcome === "bypass" ||
          outcome === "error") &&
        (source === "runtime" || source === "prerender") &&
        claimItem()
      ) {
        renderCache.push({
          segmentId: event.segmentId ?? null,
          ownerType: diagnosticString(event.data.ownerType),
          kind,
          outcome,
          reason: diagnosticString(event.data.reason),
          source,
          storeKind: diagnosticString(event.data.storeKind),
          ttl: diagnosticNumber(event.data.ttl),
          swr: diagnosticNumber(event.data.swr),
          freshForMs: diagnosticNumber(event.data.freshForMs),
          tags,
          identityDigest: diagnosticString(event.data.identityDigest),
          backgroundRevalidationClaimed:
            diagnosticBoolean(event.data.backgroundRevalidationClaimed) ??
            false,
        });
      }
      continue;
    }

    if (event.type.startsWith("ppr.")) {
      const target =
        event.type === "ppr.document"
          ? ppr.document
          : event.type === "ppr.capture"
            ? ppr.capture
            : event.type === "ppr.navigation-replay"
              ? ppr.navigationReplay
              : null;
      if (target && claimItem()) target.push(pprExplanation(event));
      continue;
    }

    if (event.type === "loader.registered") {
      const loaderId = diagnosticString(event.data.loaderId);
      const lane = diagnosticString(event.data.lane);
      const boundary = diagnosticString(event.data.boundary);
      const dataCache = diagnosticString(event.data.dataCache);
      const registeredBy = diagnosticString(event.data.registeredBy);
      const segmentId = event.segmentId;
      const current = loaderId ? loader(loaderId) : null;
      if (
        current &&
        registeredBy &&
        segmentId &&
        (lane === "live" || lane === "baked") &&
        (boundary === "loading" || boundary === "none") &&
        (dataCache === "configured" ||
          dataCache === "disabled" ||
          dataCache === "none") &&
        claimItem()
      ) {
        current.value.registrations.push({
          registeredBy,
          segmentId,
          lane,
          boundary,
          dataCache,
        });
        loadersBySegment.set(segmentId, current);
      }
      continue;
    }

    if (event.type === "loader.cache") {
      const loaderId = diagnosticString(event.data.loaderId);
      const outcome = diagnosticString(event.data.outcome);
      const current = loaderId ? loader(loaderId) : null;
      if (
        current &&
        (outcome === "hit" ||
          outcome === "stale" ||
          outcome === "miss" ||
          outcome === "bypass") &&
        claimItem()
      ) {
        const decision: LoaderCacheExplanation = {
          outcome,
          reason: diagnosticString(event.data.reason),
          ttl: diagnosticNumber(event.data.ttl),
          swr: diagnosticNumber(event.data.swr),
          backgroundRevalidationRequested:
            diagnosticBoolean(event.data.backgroundRevalidationRequested) ??
            false,
        };
        current.value.cacheDecisions.push(decision);
      }
      continue;
    }

    if (event.type === "loader.consumer") {
      const loaderId = diagnosticString(event.data.loaderId);
      const kind = diagnosticString(event.data.kind);
      let lane = diagnosticString(event.data.lane);
      let boundary = diagnosticString(event.data.boundary);
      const containerValue = diagnosticString(event.data.containerValue);
      const nestedPromises = diagnosticString(event.data.nestedPromises);
      const consumerId = diagnosticString(event.data.consumerId);
      if (kind === "loader-dependency" && lane === "inherit") {
        const registration = consumerId
          ? loaders.get(consumerId)?.value.registrations.at(-1)
          : undefined;
        lane = registration?.lane ?? null;
        boundary = registration?.boundary ?? null;
      }
      const current = loaderId ? loader(loaderId) : null;
      if (
        current &&
        (kind === "dsl-client" ||
          kind === "handler" ||
          kind === "loader-dependency") &&
        (lane === "live" || lane === "baked") &&
        (boundary === "loading" ||
          boundary === "consumer-suspense" ||
          boundary === "none") &&
        (containerValue === "request" ||
          containerValue === "capture-generation") &&
        (nestedPromises === "none" || nestedPromises === "request") &&
        claimItem()
      ) {
        const consumer: LoaderConsumerExplanation = {
          kind,
          consumerId,
          lane,
          boundary,
          containerValue,
          nestedPromises,
        };
        current.value.consumers.push(consumer);
      }
      continue;
    }

    if (event.type === "phase.completed" || event.type === "phase.failed") {
      const phase = diagnosticString(event.data.phase);
      const label = diagnosticString(event.data.label);
      const durationMs = diagnosticNumber(event.data.durationMs) ?? 0;
      if (phase === "loader" && label) {
        const current = loader(label);
        if (current) {
          if (event.type === "phase.completed") {
            current.completedDuration = durationMs;
          } else {
            current.failedDuration = durationMs;
          }
        }
      } else if (phase === "handler" && label && claimItem()) {
        handlers.push({
          handlerId: label,
          outcome: event.type === "phase.completed" ? "ran" : "error",
          durationMs,
        });
      }
    }

    if (event.type.startsWith("render.stage:") && claimItem()) {
      renderStages.push({
        type: event.type.slice("render.".length),
        phase: diagnosticString(event.data.phase),
        durationMs: diagnosticNumber(event.data.durationMs),
      });
    }

    if (
      event.type === "error.reported" &&
      diagnosticString(event.data.phase) === "loader"
    ) {
      const current = event.segmentId
        ? loadersBySegment.get(event.segmentId)
        : undefined;
      if (current) {
        current.failedHandledByBoundary =
          diagnosticBoolean(event.data.handledByBoundary) ?? false;
      }
    }

    if (isErrorEvent(event) && claimItem()) {
      errors.push({
        type: event.type,
        phase: diagnosticString(event.data.phase),
        error: diagnosticErrorSummary(event.data.error ?? event.data),
      });
    }
  }

  const projectedLoaders = [...loaders.values()].map((current) => {
    const cached = current.value.cacheDecisions.find(
      (decision) => decision.outcome === "hit" || decision.outcome === "stale",
    );
    if (cached) {
      current.value.execution = {
        outcome: "cached",
        freshness: cached.outcome === "stale" ? "stale" : "fresh",
      };
    } else if (current.failedDuration !== null) {
      current.value.execution = {
        outcome: "error",
        durationMs: current.failedDuration,
        handledByBoundary: current.failedHandledByBoundary,
      };
    } else if (current.completedDuration !== null) {
      current.value.execution = {
        outcome: "ran",
        durationMs: current.completedDuration,
      };
    }
    return current.value;
  });
  const transactionIds = trace.transactionIds.slice(0, MAX_EXPLANATION_ITEMS);
  if (transactionIds.length < trace.transactionIds.length) truncated = true;

  return {
    schemaVersion: RANGO_MCP_SCHEMA_VERSION,
    request: {
      requestId: trace.requestId,
      transactionIds,
      method: diagnosticString(started?.data.method),
      transport: isRequestTransport(transport) ? transport : null,
      routeKey: classified?.routeKey ?? null,
      routePattern: routePattern(classified),
    },
    renderCache,
    ppr,
    loaders: projectedLoaders,
    handlers,
    renderStages,
    errors,
    truncated,
  };
}

function projectRevalidationExplanation(
  trace: DiagnosticTrace,
  event: DiagnosticEvent,
): RevalidationExplanationSnapshot {
  const rawEntries = Array.isArray(event.data.entries)
    ? event.data.entries
    : [];
  let truncated =
    trace.truncated ||
    trace.droppedEvents > 0 ||
    diagnosticBoolean(event.data.entriesTruncated) === true ||
    rawEntries.length > MAX_EXPLANATION_ITEMS;
  const decisions: RevalidationDecisionExplanation[] = [];
  for (const value of rawEntries.slice(0, MAX_EXPLANATION_ITEMS)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      truncated = true;
      continue;
    }
    const entry = value as Record<string, DiagnosticValue>;
    const segmentId = diagnosticString(entry.segmentId);
    const segmentType = diagnosticString(entry.segmentType);
    const source = diagnosticString(entry.source);
    const reason = diagnosticString(entry.reason);
    if (!segmentId || !segmentType || !source || !reason) {
      truncated = true;
      continue;
    }
    decisions.push({
      segmentId,
      segmentType,
      kind:
        source === "loader" || source === "intercept-loader"
          ? "loader"
          : "segment",
      belongsToRoute: diagnosticBoolean(entry.belongsToRoute) ?? false,
      source,
      defaultShouldRevalidate:
        diagnosticBoolean(entry.defaultShouldRevalidate) ?? false,
      finalShouldRevalidate:
        diagnosticBoolean(entry.finalShouldRevalidate) ?? false,
      reason,
      customRevalidators: diagnosticNumber(entry.customRevalidators) ?? 0,
    });
  }
  const previousSearchNames = diagnosticStringsWithTruncation(
    event.data.previousSearchNames,
  );
  const nextSearchNames = diagnosticStringsWithTruncation(
    event.data.nextSearchNames,
  );
  truncated ||= previousSearchNames.truncated || nextSearchNames.truncated;

  return {
    schemaVersion: RANGO_MCP_SCHEMA_VERSION,
    requestId: trace.requestId,
    transactionId: event.transactionId,
    routeKey: event.routeKey ?? diagnosticString(event.data.routeKey),
    method: diagnosticString(event.data.method),
    isAction: diagnosticBoolean(event.data.isAction) ?? false,
    actionId: diagnosticString(event.data.actionId),
    stale: diagnosticBoolean(event.data.stale) ?? false,
    pathChanged: diagnosticBoolean(event.data.pathChanged) ?? false,
    previousSearchNames: previousSearchNames.values,
    nextSearchNames: nextSearchNames.values,
    decisions,
    truncated,
  };
}

function traceSource(
  trace: DiagnosticTrace,
  getRouteSource: DiagnosticStoreOptions["getRouteSource"],
  classified: DiagnosticEvent | undefined = classifiedEvent(trace),
): RouteSourceOwnership | null {
  return getRouteSource(
    trace.routerId,
    classified?.routeKey ?? null,
    routePattern(classified),
  );
}

function compilationFile(projectRoot: string, value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const withoutQuery = value.split("?", 1)[0]!;
  const projected = isAbsolute(withoutQuery)
    ? relative(projectRoot, withoutQuery)
    : withoutQuery;
  if (projected === "" || projected.startsWith("..") || isAbsolute(projected)) {
    return null;
  }
  return sanitizeDiagnosticText(projected.replaceAll("\\", "/"), 2_048);
}

export function createRangoMcpDiagnosticStore(
  options: DiagnosticStoreOptions,
): RangoMcpDiagnosticStore {
  const hub = new DiagnosticHub();
  const realmSequences = new Map<string, RealmBatchState>();
  const receipts = new Map<string, RequestReceipt>();
  const navigations = new Map<string, RetainedNavigation>();
  const navigationSequences = new Map<string, number>();
  const navigationDocumentCounts = new Map<string, number>();
  const requestNavigationIds = new Map<string, Set<string>>();
  const compilationIssues = new Map<string, CompilationIssueRecord>();
  let acceptedBatches = 0;
  let rejectedBatches = 0;
  let duplicateBatches = 0;
  let bridgeDroppedEvents = 0;
  let requestRevision = 0;
  let navigationRevision = 0;
  let errorRevision = 0;
  let compilationRevision = 0;
  let compilationIssueId = 0;
  let droppedIssues = 0;
  let structuredErrorCapture = false;

  const removeNavigation = (navigationId: string): void => {
    const removed = navigations.get(navigationId);
    if (!removed) return;
    navigations.delete(navigationId);
    const remaining =
      (navigationDocumentCounts.get(removed.documentId) ?? 1) - 1;
    if (remaining <= 0) {
      navigationDocumentCounts.delete(removed.documentId);
      navigationSequences.delete(removed.documentId);
    } else {
      navigationDocumentCounts.set(removed.documentId, remaining);
    }
    let linksRemoved = false;
    for (const requestId of removed.requestIds) {
      const linked = requestNavigationIds.get(requestId);
      if (linked?.delete(navigationId)) linksRemoved = true;
      if (linked?.size === 0) requestNavigationIds.delete(requestId);
    }
    if (linksRemoved) requestRevision++;
  };

  const syncReceipts = (
    retained: ReadonlyMap<string, ReadonlySet<number>>,
  ): void => {
    for (const [requestId, receipt] of receipts) {
      const retainedSequences = retained.get(requestId);
      if (!retainedSequences) {
        receipts.delete(requestId);
        requestRevision++;
        errorRevision++;
        continue;
      }
      let removed = false;
      for (const sequence of receipt.eventReceivedAt.keys()) {
        if (retainedSequences.has(sequence)) continue;
        receipt.eventReceivedAt.delete(sequence);
        removed = true;
      }
      if (removed) errorRevision++;
    }
  };

  const listRetainedTraces = (now: number): DiagnosticTrace[] => {
    const traces = hub.listTraces(now);
    syncReceipts(
      new Map(
        traces.map((trace) => [
          trace.requestId,
          new Set(trace.events.map((event) => event.sequence)),
        ]),
      ),
    );
    return traces;
  };

  const bridgeStats = (): DiagnosticBridgeStats => ({
    acceptedBatches,
    rejectedBatches,
    duplicateBatches,
    bridgeDroppedEvents,
    hubDroppedEvents: hub.getStats(performance.now()).droppedEvents,
  });

  const cursorOffset = (
    cursorValue: string | undefined,
    kind: StoreCursor["kind"],
    revision: number,
    filter: string,
  ): number => {
    if (!cursorValue) return 0;
    const cursor = decodeCursor(cursorValue);
    if (cursor.instanceId !== options.instanceId) {
      throw new Error(
        "Diagnostic cursor belongs to a previous development server; request the first page again",
      );
    }
    if (cursor.kind !== kind || cursor.filter !== filter) {
      throw new Error("Diagnostic cursor does not match the tool filters");
    }
    if (cursor.revision !== revision) {
      throw new Error(
        "Diagnostic state changed after this cursor was issued; request the first page again",
      );
    }
    return cursor.offset;
  };

  const requestSummary = (trace: DiagnosticTrace): RequestSummary => {
    let classified: DiagnosticEvent | undefined;
    let started: DiagnosticEvent | undefined;
    let completed: DiagnosticEvent | undefined;
    let errorCount = 0;
    for (const event of trace.events) {
      if (!started && event.type === "request.started") started = event;
      if (!classified && event.type === "request.classified") {
        classified = event;
      }
      if (event.type === "request.completed") completed = event;
      if (isErrorEvent(event)) errorCount++;
    }
    const receipt = receipts.get(trace.requestId);
    const transport = classified?.data.transport;
    const pattern = routePattern(classified);
    return {
      requestId: trace.requestId,
      routerId: trace.routerId,
      clientCorrelationId: trace.clientCorrelationId,
      navigationIds: [
        ...(requestNavigationIds.get(trace.requestId) ?? new Set<string>()),
      ].slice(0, 64),
      method:
        typeof started?.data.method === "string" ? started.data.method : null,
      transport: isRequestTransport(transport) ? transport : null,
      routeKey: classified?.routeKey ?? null,
      routePattern: pattern,
      status:
        typeof completed?.data.status === "number"
          ? completed.data.status
          : null,
      startedAt: new Date(receipt?.firstSeenAt ?? 0).toISOString(),
      updatedAt: new Date(receipt?.lastSeenAt ?? 0).toISOString(),
      completed: trace.completed,
      errorCount,
      eventCount: trace.events.length,
      truncated: trace.truncated || trace.droppedEvents > 0,
      droppedEvents: trace.droppedEvents,
      source: traceSource(trace, options.getRouteSource, classified),
    };
  };

  const applyBridgeBatch = (
    batch: PendingBridgeBatch,
    realmState: RealmBatchState,
  ): void => {
    const observedAt = Math.max(realmState.lastObservedAt, batch.observedAt);
    realmState.lastObservedAt = observedAt;
    bridgeDroppedEvents += batch.droppedEvents;

    for (const input of batch.events) {
      const recorded = hub.record(input, observedAt);
      if (!recorded) continue;
      const existingReceipt = receipts.get(input.requestId);
      const receipt = existingReceipt ?? {
        firstSeenAt: batch.receivedAt,
        lastSeenAt: batch.receivedAt,
        eventReceivedAt: new Map<number, number>(),
      };
      receipt.firstSeenAt = Math.min(receipt.firstSeenAt, batch.receivedAt);
      receipt.lastSeenAt = Math.max(receipt.lastSeenAt, batch.receivedAt);
      const errorEvent = isErrorEvent(recorded);
      if (errorEvent) {
        receipt.eventReceivedAt.set(recorded.sequence, batch.receivedAt);
      }
      receipts.set(input.requestId, receipt);
      requestRevision++;
      if (errorEvent) errorRevision++;
    }

    let attributedDrops = 0;
    for (const entry of batch.droppedEventsByRequest) {
      attributedDrops += entry.droppedEvents;
      hub.noteDroppedEvents(entry.droppedEvents, entry.requestId);
      if (hub.getTrace(entry.requestId, observedAt)) requestRevision++;
    }
    hub.noteDroppedEvents(batch.droppedEvents - attributedDrops);
    syncReceipts(hub.getRetainedEventSequences(observedAt));
  };

  const flushRealmBatches = (realmState: RealmBatchState): void => {
    let pending = realmState.pendingBatches.get(realmState.nextSequence);
    while (pending) {
      realmState.pendingBatches.delete(realmState.nextSequence);
      realmState.nextSequence++;
      applyBridgeBatch(pending, realmState);
      pending = realmState.pendingBatches.get(realmState.nextSequence);
    }
    if (realmState.pendingBatches.size === 0 && realmState.gapTimer) {
      clearTimeout(realmState.gapTimer);
      realmState.gapTimer = undefined;
    }
  };

  const scheduleRealmGapRecovery = (realmState: RealmBatchState): void => {
    if (
      realmState.gapTimer ||
      realmState.pendingBatches.size === 0 ||
      realmState.pendingBatches.has(realmState.nextSequence)
    ) {
      return;
    }
    realmState.gapTimer = setTimeout(() => {
      realmState.gapTimer = undefined;
      const firstAvailable = Math.min(...realmState.pendingBatches.keys());
      if (!Number.isFinite(firstAvailable)) return;
      const affectedRequestIds = new Set<string>();
      for (const pending of realmState.pendingBatches.values()) {
        for (const event of pending.events) {
          affectedRequestIds.add(event.requestId);
        }
      }
      realmState.nextSequence = firstAvailable;
      flushRealmBatches(realmState);
      if (affectedRequestIds.size === 0) {
        hub.noteDroppedEvent();
      } else {
        for (const requestId of affectedRequestIds) {
          hub.noteDroppedEvent(requestId);
          if (hub.getTrace(requestId, realmState.lastObservedAt)) {
            requestRevision++;
          }
        }
      }
      scheduleRealmGapRecovery(realmState);
    }, REORDERED_BATCH_GAP_TIMEOUT_MS);
    realmState.gapTimer.unref?.();
  };

  const store: RangoMcpDiagnosticStore = {
    ingestBridgeBatch(
      value: unknown,
      observedAt: number = performance.now(),
      receivedAt: number = Date.now(),
    ): boolean {
      let serializedBytes: number;
      try {
        serializedBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
      } catch {
        rejectedBatches++;
        return false;
      }
      if (
        serializedBytes > RANGO_DIAGNOSTIC_MAX_BATCH_BYTES ||
        !value ||
        typeof value !== "object" ||
        Array.isArray(value)
      ) {
        rejectedBatches++;
        return false;
      }
      const batch = value as Partial<DiagnosticBridgeBatch>;
      if (
        batch.bridgeVersion !== RANGO_DIAGNOSTIC_BRIDGE_VERSION ||
        batch.diagnosticSchemaVersion !== 1 ||
        typeof batch.realmId !== "string" ||
        batch.realmId.length === 0 ||
        batch.realmId.length > 128 ||
        !Number.isSafeInteger(batch.batchSequence) ||
        (batch.batchSequence ?? 0) <= 0 ||
        !Number.isSafeInteger(batch.droppedEvents) ||
        (batch.droppedEvents ?? -1) < 0 ||
        !Array.isArray(batch.droppedEventsByRequest) ||
        batch.droppedEventsByRequest.length >
          RANGO_DIAGNOSTIC_MAX_DROP_REQUESTS ||
        !Array.isArray(batch.events) ||
        (batch.events.length === 0 && batch.droppedEvents === 0) ||
        batch.events.length > RANGO_DIAGNOSTIC_MAX_BATCH_EVENTS
      ) {
        rejectedBatches++;
        return false;
      }

      const sanitizedEvents = batch.events.map((event) => ({
        sourceSequence:
          event && typeof event === "object" && !Array.isArray(event)
            ? (event as Partial<DiagnosticEvent>).sequence
            : undefined,
        input: sanitizeBridgeEvent(event),
      }));
      if (sanitizedEvents.some((event) => event.input === null)) {
        rejectedBatches++;
        return false;
      }
      const requestDrops = batch.droppedEventsByRequest;
      const dropRequestIds = new Set<string>();
      const sanitizedRequestDrops: PendingBridgeBatch["droppedEventsByRequest"] =
        [];
      let attributedDrops = 0;
      for (const value of requestDrops) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          rejectedBatches++;
          return false;
        }
        const entry = value as { requestId?: unknown; droppedEvents?: unknown };
        if (
          typeof entry.requestId !== "string" ||
          entry.requestId.length === 0 ||
          Buffer.byteLength(entry.requestId, "utf8") > 128 ||
          !Number.isSafeInteger(entry.droppedEvents) ||
          (entry.droppedEvents as number) <= 0
        ) {
          rejectedBatches++;
          return false;
        }
        const requestId = sanitizeDiagnosticText(entry.requestId, 128);
        if (dropRequestIds.has(requestId)) {
          rejectedBatches++;
          return false;
        }
        dropRequestIds.add(requestId);
        attributedDrops += entry.droppedEvents as number;
        if (!Number.isSafeInteger(attributedDrops)) {
          rejectedBatches++;
          return false;
        }
        sanitizedRequestDrops.push({
          requestId,
          droppedEvents: entry.droppedEvents as number,
        });
      }
      if (attributedDrops > batch.droppedEvents!) {
        rejectedBatches++;
        return false;
      }

      const realmId = sanitizeDiagnosticText(batch.realmId, 128);
      let realmState = realmSequences.get(realmId);
      if (!realmState && realmSequences.size >= MAX_REALMS) {
        const evictedRealmId = realmSequences.keys().next().value as string;
        clearTimeout(realmSequences.get(evictedRealmId)?.gapTimer);
        realmSequences.delete(evictedRealmId);
      }
      realmState ??= {
        nextSequence: 1,
        lastObservedAt: 0,
        pendingBatches: new Map<number, PendingBridgeBatch>(),
      };
      const sequence = batch.batchSequence!;
      if (
        sequence < realmState.nextSequence ||
        realmState.pendingBatches.has(sequence)
      ) {
        duplicateBatches++;
        return true;
      }
      if (sequence - realmState.nextSequence > MAX_REORDERED_BATCHES) {
        rejectedBatches++;
        return false;
      }
      sanitizedEvents.sort(
        (left, right) => left.sourceSequence! - right.sourceSequence!,
      );
      realmState.pendingBatches.set(sequence, {
        events: sanitizedEvents.map(
          (event) => event.input as DiagnosticEventInput,
        ),
        droppedEvents: batch.droppedEvents!,
        droppedEventsByRequest: sanitizedRequestDrops,
        observedAt,
        receivedAt,
      });
      realmSequences.set(realmId, realmState);
      acceptedBatches++;
      flushRealmBatches(realmState);
      scheduleRealmGapRecovery(realmState);
      return true;
    },

    ingestBrowserNavigationEvent(
      value: unknown,
      receivedAt: number = Date.now(),
    ): boolean {
      let bytes: number;
      try {
        bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
      } catch {
        return false;
      }
      if (bytes > 16 * 1024) return false;
      const event = sanitizeBrowserNavigationEvent(value);
      if (!event) return false;
      const previousSequence = navigationSequences.get(event.documentId) ?? 0;
      if (event.sequence <= previousSequence) return true;

      let navigation = navigations.get(event.navigationId);
      if (
        navigation &&
        (navigation.documentId !== event.documentId ||
          navigation.kind !== event.kind ||
          navigation.pathname !== event.pathname)
      ) {
        return false;
      }
      if (!navigation) {
        if (event.phase !== "started") return false;
        while (navigations.size >= MAX_NAVIGATIONS) {
          let oldestId: string | undefined;
          for (const [candidateId, candidate] of navigations) {
            if (candidate.completed) {
              oldestId = candidateId;
              break;
            }
            oldestId ??= candidateId;
          }
          if (!oldestId) break;
          removeNavigation(oldestId);
        }
        navigation = {
          navigationId: event.navigationId,
          documentId: event.documentId,
          kind: event.kind,
          pathname: event.pathname,
          firstSeenAt: receivedAt,
          lastSeenAt: receivedAt,
          completed: false,
          requestIds: new Set(),
          events: [],
          truncated: false,
        };
        navigations.set(event.navigationId, navigation);
        navigationDocumentCounts.set(
          event.documentId,
          (navigationDocumentCounts.get(event.documentId) ?? 0) + 1,
        );
      } else if (navigation.completed && event.phase !== "request-linked") {
        navigationSequences.set(event.documentId, event.sequence);
        return true;
      } else if (event.phase === "started") {
        navigationSequences.set(event.documentId, event.sequence);
        return true;
      }
      navigationSequences.set(event.documentId, event.sequence);
      navigation.lastSeenAt = receivedAt;
      if (navigation.events.length < MAX_NAVIGATION_EVENTS) {
        navigation.events.push(event);
      } else {
        navigation.truncated = true;
      }
      if (
        event.phase === "committed" ||
        event.phase === "aborted" ||
        event.phase === "failed"
      ) {
        navigation.completed = true;
      }
      if (event.phase === "request-linked" && event.requestId) {
        if (
          navigation.requestIds.has(event.requestId) ||
          navigation.requestIds.size < MAX_NAVIGATION_REQUESTS
        ) {
          navigation.requestIds.add(event.requestId);
          const linked = requestNavigationIds.get(event.requestId) ?? new Set();
          linked.add(event.navigationId);
          requestNavigationIds.set(event.requestId, linked);
          requestRevision++;
        } else {
          navigation.truncated = true;
        }
      }
      navigationRevision++;
      return true;
    },

    listRequests(input: ListRequestsInput = {}): RequestsPageSnapshot {
      const now = performance.now();
      const traces = listRetainedTraces(now);
      const since = parseSince(input.since);
      const filter = JSON.stringify({
        routerId: input.routerId ?? null,
        requestId: input.requestId ?? null,
        navigationId: input.navigationId ?? null,
        transport: input.transport ?? null,
        routePattern: input.routePattern ?? null,
        completed: input.completed ?? null,
        since,
      });
      const offset = cursorOffset(
        input.cursor,
        "requests",
        requestRevision,
        filter,
      );
      const summaries = traces
        .map(requestSummary)
        .filter((summary) => {
          if (input.routerId && summary.routerId !== input.routerId)
            return false;
          if (input.requestId && summary.requestId !== input.requestId)
            return false;
          if (
            input.navigationId &&
            !summary.navigationIds.includes(input.navigationId)
          )
            return false;
          if (input.transport && summary.transport !== input.transport)
            return false;
          if (input.routePattern && summary.routePattern !== input.routePattern)
            return false;
          if (
            input.completed !== undefined &&
            summary.completed !== input.completed
          )
            return false;
          return since === null || Date.parse(summary.updatedAt) >= since;
        })
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      const limit = pageLimit(input.limit);
      const stats = bridgeStats();
      const requestCursor = (nextOffset: number): string | null =>
        nextOffset < summaries.length
          ? encodeCursor({
              instanceId: options.instanceId,
              kind: "requests",
              revision: requestRevision,
              filter,
              offset: nextOffset,
            })
          : null;
      const { page: requests, stoppedForSize } = pageWithinResultLimit(
        summaries,
        offset,
        limit,
        (page, nextOffset): RequestsPageSnapshot => ({
          schemaVersion: RANGO_MCP_SCHEMA_VERSION,
          requests: page,
          nextCursor: requestCursor(nextOffset),
          truncated: false,
          stats,
        }),
      );
      const nextOffset = offset + requests.length;
      const result: RequestsPageSnapshot = {
        schemaVersion: RANGO_MCP_SCHEMA_VERSION,
        requests,
        nextCursor: requestCursor(nextOffset),
        truncated: stoppedForSize,
        stats,
      };
      if (serializedToolResultBytes(result) > RANGO_MCP_MAX_RESULT_BYTES) {
        throw new Error("Rango MCP request page exceeded its output limit");
      }
      return result;
    },

    listNavigations(input: ListNavigationsInput = {}): NavigationsPageSnapshot {
      const since = parseSince(input.since);
      const filter = JSON.stringify({
        navigationId: input.navigationId ?? null,
        kind: input.kind ?? null,
        completed: input.completed ?? null,
        since,
      });
      const offset = cursorOffset(
        input.cursor,
        "navigations",
        navigationRevision,
        filter,
      );
      const summaries: NavigationSummary[] = [...navigations.values()]
        .map((navigation) => ({
          navigationId: navigation.navigationId,
          documentId: navigation.documentId,
          kind: navigation.kind,
          pathname: navigation.pathname,
          startedAt: new Date(navigation.firstSeenAt).toISOString(),
          updatedAt: new Date(navigation.lastSeenAt).toISOString(),
          completed: navigation.completed,
          requestIds: [...navigation.requestIds].slice(0, 64),
          eventCount: navigation.events.length,
          truncated: navigation.truncated || navigation.requestIds.size > 64,
        }))
        .filter((navigation) => {
          if (
            input.navigationId &&
            navigation.navigationId !== input.navigationId
          )
            return false;
          if (input.kind && navigation.kind !== input.kind) return false;
          if (
            input.completed !== undefined &&
            navigation.completed !== input.completed
          )
            return false;
          return since === null || Date.parse(navigation.updatedAt) >= since;
        })
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      const limit = pageLimit(input.limit);
      const navigationCursor = (nextOffset: number): string | null =>
        nextOffset < summaries.length
          ? encodeCursor({
              instanceId: options.instanceId,
              kind: "navigations",
              revision: navigationRevision,
              filter,
              offset: nextOffset,
            })
          : null;
      const { page, stoppedForSize } = pageWithinResultLimit(
        summaries,
        offset,
        limit,
        (items, nextOffset): NavigationsPageSnapshot => ({
          schemaVersion: RANGO_MCP_SCHEMA_VERSION,
          navigations: items,
          nextCursor: navigationCursor(nextOffset),
          truncated: false,
        }),
      );
      return {
        schemaVersion: RANGO_MCP_SCHEMA_VERSION,
        navigations: page,
        nextCursor: navigationCursor(offset + page.length),
        truncated: stoppedForSize,
      };
    },

    getNavigationTrace(
      input: GetNavigationTraceInput,
    ): NavigationTraceSnapshot {
      const navigation = navigations.get(input.navigationId);
      if (!navigation) {
        throw new Error(
          `No retained browser navigation for ${input.navigationId}`,
        );
      }
      const snapshot: NavigationTraceSnapshot = {
        schemaVersion: RANGO_MCP_SCHEMA_VERSION,
        navigationId: navigation.navigationId,
        documentId: navigation.documentId,
        kind: navigation.kind,
        pathname: navigation.pathname,
        completed: navigation.completed,
        requestIds: [...navigation.requestIds].slice(0, 64),
        events: [...navigation.events],
        truncated: navigation.truncated || navigation.requestIds.size > 64,
      };
      while (
        snapshot.events.length > 0 &&
        serializedToolResultBytes(snapshot) > RANGO_MCP_MAX_RESULT_BYTES
      ) {
        snapshot.events.shift();
        snapshot.truncated = true;
      }
      if (serializedToolResultBytes(snapshot) > RANGO_MCP_MAX_RESULT_BYTES) {
        throw new Error("Rango MCP navigation trace exceeded its output limit");
      }
      return snapshot;
    },

    getRequestTrace(input: GetRequestTraceInput): RequestTraceSnapshot {
      const trace = hub.getTrace(input.requestId, performance.now());
      if (!trace) {
        throw new Error(`No retained request trace for ${input.requestId}`);
      }
      const originalEventCount = trace.events.length;
      const originalTransactionCount = trace.transactionIds.length;
      const transactionIds =
        originalTransactionCount <= MAX_TRACE_TRANSACTION_IDS
          ? trace.transactionIds
          : [
              ...trace.transactionIds.slice(0, 2),
              ...trace.transactionIds.slice(-(MAX_TRACE_TRANSACTION_IDS - 2)),
            ];
      const omittedTransactions =
        originalTransactionCount - transactionIds.length;
      const snapshot: RequestTraceSnapshot = {
        schemaVersion: RANGO_MCP_SCHEMA_VERSION,
        trace: { ...trace, transactionIds },
        source: traceSource(trace, options.getRouteSource),
        outputTruncated: omittedTransactions > 0,
        omittedEvents: 0,
        omittedTransactions,
      };
      if (serializedToolResultBytes(snapshot) > RANGO_MCP_MAX_RESULT_BYTES) {
        const events = trace.events;
        const leadingCount = Math.min(2, events.length);
        let low = 0;
        let high = events.length - leadingCount;
        let bestEvents = events.slice(0, leadingCount);
        while (low <= high) {
          const tailCount = Math.floor((low + high) / 2);
          const candidateEvents = [
            ...events.slice(0, leadingCount),
            ...(tailCount === 0 ? [] : events.slice(-tailCount)),
          ];
          const candidate: RequestTraceSnapshot = {
            ...snapshot,
            trace: { ...trace, events: candidateEvents, transactionIds },
            outputTruncated: true,
            omittedEvents: originalEventCount - candidateEvents.length,
          };
          if (
            serializedToolResultBytes(candidate) <= RANGO_MCP_MAX_RESULT_BYTES
          ) {
            bestEvents = candidateEvents;
            low = tailCount + 1;
          } else {
            high = tailCount - 1;
          }
        }
        snapshot.trace.events = bestEvents;
        snapshot.outputTruncated = true;
        snapshot.omittedEvents = originalEventCount - bestEvents.length;
      }
      if (serializedToolResultBytes(snapshot) > RANGO_MCP_MAX_RESULT_BYTES) {
        throw new Error("Rango MCP request trace exceeded its output limit");
      }
      return snapshot;
    },

    explainRender(input: ExplainRenderInput): RenderExplanationSnapshot {
      const trace = hub.getTrace(input.requestId, performance.now());
      if (!trace) {
        throw new Error(`No retained request trace for ${input.requestId}`);
      }
      const explanation = projectRenderExplanation(trace);
      if (serializedToolResultBytes(explanation) > RANGO_MCP_MAX_RESULT_BYTES) {
        throw new Error(
          "Rango MCP render explanation exceeded its output limit",
        );
      }
      return explanation;
    },

    explainCacheTags(
      input: ExplainCacheTagsInput,
    ): CacheTagExplanationSnapshot {
      const trace = hub.getTrace(input.requestId, performance.now());
      if (!trace) {
        throw new Error(`No retained request trace for ${input.requestId}`);
      }
      const explanation = projectCacheTagExplanation(
        trace,
        input.transactionId,
      );
      if (serializedToolResultBytes(explanation) > RANGO_MCP_MAX_RESULT_BYTES) {
        throw new Error(
          "Rango MCP cache-tag explanation exceeded its output limit",
        );
      }
      return explanation;
    },

    explainRevalidation(
      input: ExplainRevalidationInput,
    ): RevalidationExplanationSnapshot {
      const trace = hub.getTrace(input.requestId, performance.now());
      let event: DiagnosticEvent | undefined;
      if (trace) {
        for (let index = trace.events.length - 1; index >= 0; index--) {
          const candidate = trace.events[index]!;
          if (
            candidate.type === "revalidation.trace" &&
            (!input.transactionId ||
              candidate.transactionId === input.transactionId)
          ) {
            event = candidate;
            break;
          }
        }
      }
      if (!trace || !event) {
        const selector = input.transactionId
          ? `${input.requestId}/${input.transactionId}`
          : input.requestId;
        throw new Error(`No retained revalidation trace for ${selector}`);
      }
      const explanation = projectRevalidationExplanation(trace, event);
      if (serializedToolResultBytes(explanation) > RANGO_MCP_MAX_RESULT_BYTES) {
        throw new Error(
          "Rango MCP revalidation explanation exceeded its output limit",
        );
      }
      return explanation;
    },

    getErrors(input: GetErrorsInput = {}): ErrorsPageSnapshot {
      const now = performance.now();
      const traces = listRetainedTraces(now);
      const since = parseSince(input.since);
      const filter = JSON.stringify({
        requestId: input.requestId ?? null,
        routerId: input.routerId ?? null,
        since,
      });
      const offset = cursorOffset(
        input.cursor,
        "errors",
        errorRevision,
        filter,
      );
      const errors: RuntimeErrorRecord[] = [];
      for (const trace of traces) {
        if (input.requestId && trace.requestId !== input.requestId) continue;
        if (input.routerId && trace.routerId !== input.routerId) continue;
        const receipt = receipts.get(trace.requestId);
        const source = traceSource(trace, options.getRouteSource);
        for (const event of trace.events) {
          if (!isErrorEvent(event)) continue;
          const eventReceivedAt =
            receipt?.eventReceivedAt.get(event.sequence) ??
            receipt?.lastSeenAt ??
            0;
          if (since !== null && eventReceivedAt < since) continue;
          const phase = event.data.phase;
          errors.push({
            id: `${trace.requestId}:${event.sequence}`,
            requestId: trace.requestId,
            transactionId: event.transactionId,
            routerId: trace.routerId,
            routeKey: event.routeKey ?? null,
            type: event.type,
            phase: typeof phase === "string" ? phase : null,
            timestamp: event.timestamp,
            receivedAt: new Date(eventReceivedAt).toISOString(),
            error: diagnosticErrorSummary(event.data.error ?? event.data),
            source,
          });
        }
      }
      errors.sort(
        (a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt),
      );
      const limit = pageLimit(input.limit);
      const errorCursor = (nextOffset: number): string | null =>
        nextOffset < errors.length
          ? encodeCursor({
              instanceId: options.instanceId,
              kind: "errors",
              revision: errorRevision,
              filter,
              offset: nextOffset,
            })
          : null;
      const { page, stoppedForSize } = pageWithinResultLimit(
        errors,
        offset,
        limit,
        (page, nextOffset): ErrorsPageSnapshot => ({
          schemaVersion: RANGO_MCP_SCHEMA_VERSION,
          errors: page,
          nextCursor: errorCursor(nextOffset),
          truncated: false,
        }),
      );
      const nextOffset = offset + page.length;
      const result: ErrorsPageSnapshot = {
        schemaVersion: RANGO_MCP_SCHEMA_VERSION,
        errors: page,
        nextCursor: errorCursor(nextOffset),
        truncated: stoppedForSize,
      };
      if (serializedToolResultBytes(result) > RANGO_MCP_MAX_RESULT_BYTES) {
        throw new Error("Rango MCP error page exceeded its output limit");
      }
      return result;
    },

    recordCompilationIssue(input: CompilationIssueInput): void {
      const timestamp = input.timestamp ?? Date.now();
      const message = sanitizeDiagnosticText(
        typeof input.message === "string" ? input.message : "Vite issue",
        4_096,
      ).replaceAll(options.projectRoot, ".");
      const file = compilationFile(options.projectRoot, input.file);
      const plugin =
        typeof input.plugin === "string"
          ? sanitizeDiagnosticText(input.plugin, 256)
          : null;
      const environment =
        typeof input.environment === "string"
          ? sanitizeDiagnosticText(input.environment, 128)
          : null;
      const frame =
        typeof input.frame === "string"
          ? sanitizeDiagnosticText(
              input.frame.replaceAll(options.projectRoot, "."),
              8_192,
            )
          : null;
      const line = safeInteger(input.line);
      const column = safeInteger(input.column);
      const fingerprint = JSON.stringify({
        severity: input.severity,
        message,
        plugin,
        file,
        line,
        column,
        environment,
        freshness: input.freshness,
      });
      const existing = compilationIssues.get(fingerprint);
      if (existing) {
        existing.lastSeenAt = new Date(timestamp).toISOString();
        existing.occurrences++;
        if (frame) existing.frame = frame;
        compilationRevision++;
        return;
      }
      if (input.freshness === "current" && file) {
        for (const [key, issue] of compilationIssues) {
          if (
            issue.freshness === "current" &&
            issue.file === file &&
            issue.environment === environment
          ) {
            compilationIssues.delete(key);
          }
        }
      }
      while (compilationIssues.size >= MAX_COMPILATION_ISSUES) {
        const recentKey = [...compilationIssues].find(
          ([, issue]) => issue.freshness === "recent",
        )?.[0];
        if (!recentKey && input.freshness === "recent") {
          droppedIssues++;
          compilationRevision++;
          return;
        }
        compilationIssues.delete(
          recentKey ?? (compilationIssues.keys().next().value as string),
        );
        droppedIssues++;
      }
      compilationIssues.set(fingerprint, {
        id: `issue-${++compilationIssueId}`,
        severity: input.severity,
        message,
        plugin,
        file,
        line,
        column,
        frame,
        environment,
        freshness: input.freshness,
        firstSeenAt: new Date(timestamp).toISOString(),
        lastSeenAt: new Date(timestamp).toISOString(),
        occurrences: 1,
      });
      compilationRevision++;
    },

    resolveCompilationFiles(files: string[], environment?: string): void {
      const projected = new Set(
        files
          .map((file) => compilationFile(options.projectRoot, file))
          .filter((file): file is string => file !== null),
      );
      let changed = false;
      for (const [key, issue] of compilationIssues) {
        if (
          issue.freshness === "current" &&
          issue.file &&
          projected.has(issue.file) &&
          (!environment || issue.environment === environment)
        ) {
          compilationIssues.delete(key);
          changed = true;
        }
      }
      if (changed) compilationRevision++;
    },

    setStructuredErrorCapture(available: boolean): void {
      structuredErrorCapture = available;
    },

    getCompilationIssues(
      input: GetCompilationIssuesInput = {},
    ): CompilationIssuesPageSnapshot {
      const now = Date.now();
      let swept = false;
      for (const [key, issue] of compilationIssues) {
        if (
          issue.freshness === "recent" &&
          now - Date.parse(issue.lastSeenAt) > MAX_RECENT_ISSUE_AGE_MS
        ) {
          compilationIssues.delete(key);
          swept = true;
        }
      }
      if (swept) compilationRevision++;
      const since = parseSince(input.since);
      const filter = JSON.stringify({
        severity: input.severity ?? null,
        since,
      });
      const offset = cursorOffset(
        input.cursor,
        "compilation",
        compilationRevision,
        filter,
      );
      const issues = [...compilationIssues.values()]
        .filter((issue) => {
          if (input.severity && issue.severity !== input.severity) return false;
          return since === null || Date.parse(issue.lastSeenAt) >= since;
        })
        .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
      const limit = pageLimit(input.limit);
      const compilationCursor = (nextOffset: number): string | null =>
        nextOffset < issues.length
          ? encodeCursor({
              instanceId: options.instanceId,
              kind: "compilation",
              revision: compilationRevision,
              filter,
              offset: nextOffset,
            })
          : null;
      const { page, stoppedForSize } = pageWithinResultLimit(
        issues,
        offset,
        limit,
        (page, nextOffset): CompilationIssuesPageSnapshot => ({
          schemaVersion: RANGO_MCP_SCHEMA_VERSION,
          issues: page,
          nextCursor: compilationCursor(nextOffset),
          truncated: false,
          capture: {
            structuredErrors: structuredErrorCapture,
            warnings: "recent-only",
          },
          droppedIssues,
        }),
      );
      const nextOffset = offset + page.length;
      const result: CompilationIssuesPageSnapshot = {
        schemaVersion: RANGO_MCP_SCHEMA_VERSION,
        issues: page,
        nextCursor: compilationCursor(nextOffset),
        truncated: stoppedForSize,
        capture: {
          structuredErrors: structuredErrorCapture,
          warnings: "recent-only",
        },
        droppedIssues,
      };
      if (serializedToolResultBytes(result) > RANGO_MCP_MAX_RESULT_BYTES) {
        throw new Error("Rango MCP compilation page exceeded its output limit");
      }
      return result;
    },
  };
  return store;
}
