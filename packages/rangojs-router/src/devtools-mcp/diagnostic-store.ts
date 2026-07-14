import { isAbsolute, relative } from "node:path";
import {
  RANGO_DIAGNOSTIC_BRIDGE_VERSION,
  RANGO_DIAGNOSTIC_MAX_BATCH_BYTES,
  RANGO_DIAGNOSTIC_MAX_BATCH_EVENTS,
  type DiagnosticBridgeBatch,
} from "../router/diagnostics/bridge-protocol.js";
import { DiagnosticHub } from "../router/diagnostics/hub.js";
import { sanitizeDiagnosticText } from "../router/diagnostics/redaction.js";
import type {
  DiagnosticEvent,
  DiagnosticEventInput,
  DiagnosticTrace,
  DiagnosticValue,
} from "../router/diagnostics/types.js";
import {
  RANGO_MCP_MAX_RESULT_BYTES,
  RANGO_MCP_SCHEMA_VERSION,
  REQUEST_TRANSPORTS,
  serializedToolResultBytes,
  type CompilationIssueRecord,
  type CompilationIssuesPageSnapshot,
  type DiagnosticBridgeStats,
  type ErrorsPageSnapshot,
  type GetCompilationIssuesInput,
  type GetErrorsInput,
  type GetRequestTraceInput,
  type ListRequestsInput,
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

interface StoreCursor {
  instanceId: string;
  kind: "requests" | "errors" | "compilation";
  revision: number;
  filter: string;
  offset: number;
}

interface RequestReceipt {
  firstSeenAt: number;
  lastSeenAt: number;
  eventReceivedAt: Map<number, number>;
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
  listRequests(input?: ListRequestsInput): RequestsPageSnapshot;
  getRequestTrace(input: GetRequestTraceInput): RequestTraceSnapshot;
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
      result[sanitizeDiagnosticText(key, 256)] = sanitizeValue(item, depth + 1);
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
  const realmSequences = new Map<string, number>();
  const receipts = new Map<string, RequestReceipt>();
  const compilationIssues = new Map<string, CompilationIssueRecord>();
  let acceptedBatches = 0;
  let rejectedBatches = 0;
  let duplicateBatches = 0;
  let bridgeDroppedEvents = 0;
  let requestRevision = 0;
  let errorRevision = 0;
  let compilationRevision = 0;
  let compilationIssueId = 0;
  let droppedIssues = 0;
  let structuredErrorCapture = false;

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
      truncated: trace.truncated,
      droppedEvents: trace.droppedEvents,
      source: traceSource(trace, options.getRouteSource, classified),
    };
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
        !Array.isArray(batch.events) ||
        (batch.events.length === 0 && batch.droppedEvents === 0) ||
        batch.events.length > RANGO_DIAGNOSTIC_MAX_BATCH_EVENTS
      ) {
        rejectedBatches++;
        return false;
      }

      const realmId = sanitizeDiagnosticText(batch.realmId, 128);
      const previousSequence = realmSequences.get(realmId) ?? 0;
      if (batch.batchSequence! <= previousSequence) {
        duplicateBatches++;
        return true;
      }
      const sanitizedEvents = batch.events.map(sanitizeBridgeEvent);
      if (sanitizedEvents.some((event) => event === null)) {
        rejectedBatches++;
        return false;
      }

      if (!realmSequences.has(realmId) && realmSequences.size >= MAX_REALMS) {
        realmSequences.delete(realmSequences.keys().next().value as string);
      }
      realmSequences.set(realmId, batch.batchSequence!);
      bridgeDroppedEvents += batch.droppedEvents!;
      hub.noteDroppedEvents(batch.droppedEvents!);

      for (const input of sanitizedEvents as DiagnosticEventInput[]) {
        const recorded = hub.record(input, observedAt);
        if (!recorded) continue;
        const receipt = receipts.get(input.requestId) ?? {
          firstSeenAt: receivedAt,
          lastSeenAt: receivedAt,
          eventReceivedAt: new Map<number, number>(),
        };
        receipt.lastSeenAt = receivedAt;
        const errorEvent = isErrorEvent(recorded);
        if (errorEvent) {
          receipt.eventReceivedAt.set(recorded.sequence, receivedAt);
        }
        receipts.set(input.requestId, receipt);
        requestRevision++;
        if (errorEvent) errorRevision++;
      }
      acceptedBatches++;
      syncReceipts(hub.getRetainedEventSequences(observedAt));
      return true;
    },

    listRequests(input: ListRequestsInput = {}): RequestsPageSnapshot {
      const now = performance.now();
      const traces = listRetainedTraces(now);
      const since = parseSince(input.since);
      const filter = JSON.stringify({
        routerId: input.routerId ?? null,
        requestId: input.requestId ?? null,
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

    getRequestTrace(input: GetRequestTraceInput): RequestTraceSnapshot {
      const trace = hub.getTrace(input.requestId, performance.now());
      if (!trace) {
        throw new Error(`No retained request trace for ${input.requestId}`);
      }
      const originalEventCount = trace.events.length;
      const snapshot: RequestTraceSnapshot = {
        schemaVersion: RANGO_MCP_SCHEMA_VERSION,
        trace,
        source: traceSource(trace, options.getRouteSource),
        outputTruncated: false,
        omittedEvents: 0,
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
            trace: { ...trace, events: candidateEvents },
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
            error: event.data.error ?? event.data,
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
