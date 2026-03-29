import { INTERNAL_RANGO_DEBUG } from "../internal-debug.js";
import {
  _getRequestContext,
  _requestContextStorage,
} from "../server/request-context.js";

// -- Revalidation trace types --

export interface RevalidationTraceEntry {
  segmentId: string;
  segmentType: string;
  belongsToRoute: boolean;
  source:
    | "segment-resolution"
    | "cache-hit"
    | "loader"
    | "parallel"
    | "orphan-layout"
    | "route-handler"
    | "layout-handler"
    | "intercept-loader";
  defaultShouldRevalidate: boolean;
  finalShouldRevalidate: boolean;
  reason: string;
  customRevalidators?: number;
}

export interface RevalidationTraceMeta {
  method: string;
  prevUrl: string;
  nextUrl: string;
  routeKey: string;
  isAction: boolean;
  stale?: boolean;
}

export interface RevalidationTrace {
  meta: RevalidationTraceMeta;
  entries: RevalidationTraceEntry[];
}

// -- Log context (stored as _logContext on the canonical request context) --

export interface RouterLogContext {
  requestId: string;
  transactionId: string;
  depth: number;
  revalidationTrace?: RevalidationTrace;
}

interface RouterLogOptions {
  request: Request;
  transaction: string;
}

interface LogDetails {
  [key: string]: unknown;
}

const requestIds = new WeakMap<Request, string>();

let requestCounter = 0;
let transactionCounter = 0;

function nextId(prefix: string, counter: number): string {
  return `${prefix}${counter.toString(36)}`;
}

function getHeaderRequestId(request: Request): string | null {
  const candidate =
    request.headers.get("x-rsc-router-request-id") ??
    request.headers.get("x-request-id") ??
    request.headers.get("cf-ray");
  if (!candidate) return null;
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function getOrCreateRequestId(request: Request): string {
  const existing = requestIds.get(request);
  if (existing) return existing;

  const fromHeaders = getHeaderRequestId(request);
  if (fromHeaders) {
    requestIds.set(request, fromHeaders);
    return fromHeaders;
  }

  requestCounter += 1;
  const generated = nextId("req-", requestCounter);
  requestIds.set(request, generated);
  return generated;
}

/**
 * Run fn with a fresh log context (request ID + transaction ID).
 * Creates a derived ALS snapshot on the canonical request context.
 * No-op when debug is disabled or no request context exists.
 */
export function runWithRouterLogContext<T>(
  options: RouterLogOptions,
  fn: () => T,
): T {
  if (!INTERNAL_RANGO_DEBUG) return fn();

  const ctx = _getRequestContext();
  if (!ctx) return fn();

  const requestId = getOrCreateRequestId(options.request);
  transactionCounter += 1;
  const transactionId = `${options.transaction}-${nextId("tx-", transactionCounter)}`;

  return _requestContextStorage.run(
    { ...ctx, _logContext: { requestId, transactionId, depth: 0 } },
    fn,
  );
}

/**
 * Run fn in a nested log scope (depth + 1).
 * Creates a derived ALS snapshot so async branches get isolated depth.
 */
export function withRouterLogScope<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T>;
export function withRouterLogScope<T>(label: string, fn: () => T): T;
export function withRouterLogScope<T>(
  label: string,
  fn: () => Promise<T> | T,
): Promise<T> | T {
  const reqCtx = _getRequestContext();
  const logCtx = reqCtx?._logContext;
  if (!INTERNAL_RANGO_DEBUG || !logCtx) return fn();

  debugLog(label, "start");

  return _requestContextStorage.run(
    { ...reqCtx!, _logContext: { ...logCtx, depth: logCtx.depth + 1 } },
    () => {
      try {
        const result = fn();
        if (result && typeof (result as Promise<T>).then === "function") {
          return (result as Promise<T>).then(
            (value) => {
              debugLog(label, "end");
              return value;
            },
            (error) => {
              debugLog(label, "error", { error: String(error) });
              throw error;
            },
          );
        }
        debugLog(label, "end");
        return result;
      } catch (error) {
        debugLog(label, "error", { error: String(error) });
        throw error;
      }
    },
  );
}

export function isRouterDebugEnabled(): boolean {
  return INTERNAL_RANGO_DEBUG && !!_getRequestContext()?._logContext;
}

function formatPrefix(scope: string): string {
  const logCtx = _getRequestContext()?._logContext;
  if (!logCtx) return `[Router][${scope}]`;
  const indent = "  ".repeat(logCtx.depth);
  return `[Router][req:${logCtx.requestId}][tx:${logCtx.transactionId}] ${indent}[${scope}]`;
}

export function debugLog(
  scope: string,
  message: string,
  details?: LogDetails,
): void {
  if (!isRouterDebugEnabled()) return;

  const prefix = formatPrefix(scope);
  if (details) {
    console.log(`${prefix} ${message}`, details);
    return;
  }

  console.log(`${prefix} ${message}`);
}

export function debugWarn(
  scope: string,
  message: string,
  details?: LogDetails,
): void {
  if (!isRouterDebugEnabled()) return;

  const prefix = formatPrefix(scope);
  if (details) {
    console.warn(`${prefix} ${message}`, details);
    return;
  }

  console.warn(`${prefix} ${message}`);
}

// -- Revalidation trace helpers --

export function isTraceActive(): boolean {
  if (!INTERNAL_RANGO_DEBUG) return false;
  const logCtx = _getRequestContext()?._logContext;
  return !!logCtx?.revalidationTrace;
}

export function startRevalidationTrace(meta: RevalidationTraceMeta): void {
  const logCtx = _getRequestContext()?._logContext;
  if (!logCtx || !INTERNAL_RANGO_DEBUG) return;
  logCtx.revalidationTrace = { meta, entries: [] };
}

export function pushRevalidationTraceEntry(
  entry: RevalidationTraceEntry,
): void {
  const logCtx = _getRequestContext()?._logContext;
  if (!logCtx?.revalidationTrace) return;
  logCtx.revalidationTrace.entries.push(entry);
}

export function flushRevalidationTrace(): RevalidationTrace | null {
  const logCtx = _getRequestContext()?._logContext;
  if (!logCtx?.revalidationTrace) return null;
  const trace = logCtx.revalidationTrace;
  logCtx.revalidationTrace = undefined;

  if (trace.entries.length === 0) return trace;

  const revalidated = trace.entries.filter(
    (e: RevalidationTraceEntry) => e.finalShouldRevalidate,
  );
  const skipped = trace.entries.filter(
    (e: RevalidationTraceEntry) => !e.finalShouldRevalidate,
  );

  debugLog("revalidation-trace", "flush", {
    method: trace.meta.method,
    routeKey: trace.meta.routeKey,
    isAction: trace.meta.isAction,
    stale: trace.meta.stale,
    prevUrl: trace.meta.prevUrl,
    nextUrl: trace.meta.nextUrl,
    total: trace.entries.length,
    revalidated: revalidated.length,
    skipped: skipped.length,
    entries: trace.entries.map((e: RevalidationTraceEntry) => ({
      segmentId: e.segmentId,
      type: e.segmentType,
      source: e.source,
      revalidate: e.finalShouldRevalidate,
      reason: e.reason,
    })),
  });

  return trace;
}
