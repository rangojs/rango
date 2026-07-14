import { AsyncLocalStorage } from "node:async_hooks";
import { INTERNAL_RANGO_DEBUG } from "../internal-debug.js";
import {
  areDevelopmentDiagnosticsAvailable,
  recordRevalidationTrace,
} from "./diagnostics/channel.js";
import { DEVELOPMENT_DIAGNOSTICS_ENABLED } from "./diagnostics/hub.js";
import {
  getActiveRequestTransaction,
  getServerRequestId,
  runWithRequestTransaction,
} from "./request-identity.js";

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

interface RouterLogContext {
  depth: number;
  revalidationTrace?: RevalidationTrace;
}

interface RouterLogOptions {
  request: Request;
  transaction: string;
  routerId?: string;
  diagnosticsEnabled?: boolean;
}

interface LogDetails {
  [key: string]: unknown;
}

const routerLogContext = new AsyncLocalStorage<RouterLogContext>();

export function getOrCreateRequestId(request: Request): string {
  return getServerRequestId(request);
}

export function runWithRouterLogContext<T>(
  options: RouterLogOptions,
  fn: () => T,
): T {
  if (!INTERNAL_RANGO_DEBUG && !DEVELOPMENT_DIAGNOSTICS_ENABLED) return fn();
  const parent = getActiveRequestTransaction();
  const diagnosticsEnabled =
    options.diagnosticsEnabled ??
    parent?.diagnosticsEnabled ??
    areDevelopmentDiagnosticsAvailable();
  if (
    !INTERNAL_RANGO_DEBUG &&
    !diagnosticsEnabled &&
    parent?.diagnosticsEnabled !== true
  ) {
    return fn();
  }

  return runWithRequestTransaction(
    options.request,
    options.transaction,
    () => routerLogContext.run({ depth: 0 }, fn),
    {
      routerId: options.routerId,
      diagnosticsEnabled,
    },
  );
}

export function withRouterLogScope<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T>;
export function withRouterLogScope<T>(label: string, fn: () => T): T;
export function withRouterLogScope<T>(
  label: string,
  fn: () => Promise<T> | T,
): Promise<T> | T {
  if (!INTERNAL_RANGO_DEBUG) return fn();
  const ctx = routerLogContext.getStore();
  if (!ctx) return fn();

  debugLog(label, "start");

  return routerLogContext.run({ ...ctx, depth: ctx.depth + 1 }, () => {
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
  });
}

export function isRouterDebugEnabled(): boolean {
  return INTERNAL_RANGO_DEBUG && !!routerLogContext.getStore();
}

function formatPrefix(scope: string): string {
  const ctx = routerLogContext.getStore();
  const transaction = getActiveRequestTransaction();
  if (!ctx || !transaction) return `[Router][${scope}]`;
  const indent = "  ".repeat(ctx.depth);
  return `[Router][req:${transaction.requestId}][tx:${transaction.transactionId}] ${indent}[${scope}]`;
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

export function isTraceActive(): boolean {
  if (!INTERNAL_RANGO_DEBUG && !DEVELOPMENT_DIAGNOSTICS_ENABLED) return false;
  const ctx = routerLogContext.getStore();
  return !!ctx?.revalidationTrace;
}

export function startRevalidationTrace(meta: RevalidationTraceMeta): void {
  if (!INTERNAL_RANGO_DEBUG && !DEVELOPMENT_DIAGNOSTICS_ENABLED) return;
  const ctx = routerLogContext.getStore();
  if (!ctx) return;
  ctx.revalidationTrace = { meta, entries: [] };
}

export function pushRevalidationTraceEntry(
  entry: RevalidationTraceEntry,
): void {
  if (!INTERNAL_RANGO_DEBUG && !DEVELOPMENT_DIAGNOSTICS_ENABLED) return;
  const ctx = routerLogContext.getStore();
  if (!ctx?.revalidationTrace) return;
  ctx.revalidationTrace.entries.push(entry);
}

export function flushRevalidationTrace(): RevalidationTrace | null {
  if (!INTERNAL_RANGO_DEBUG && !DEVELOPMENT_DIAGNOSTICS_ENABLED) return null;
  const ctx = routerLogContext.getStore();
  if (!ctx?.revalidationTrace) return null;
  const trace = ctx.revalidationTrace;
  ctx.revalidationTrace = undefined;

  recordRevalidationTrace(trace);

  if (trace.entries.length === 0) return trace;

  const revalidated = trace.entries.filter((e) => e.finalShouldRevalidate);
  const skipped = trace.entries.filter((e) => !e.finalShouldRevalidate);

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
    entries: trace.entries.map((e) => ({
      segmentId: e.segmentId,
      type: e.segmentType,
      source: e.source,
      revalidate: e.finalShouldRevalidate,
      reason: e.reason,
    })),
  });

  return trace;
}
