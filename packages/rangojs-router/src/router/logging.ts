import { AsyncLocalStorage } from "node:async_hooks";
import { INTERNAL_RANGO_DEBUG } from "../internal-debug.js";

interface RouterLogContext {
  requestId: string;
  transactionId: string;
  depth: number;
}

interface RouterLogOptions {
  request: Request;
  transaction: string;
}

interface LogDetails {
  [key: string]: unknown;
}

const routerLogContext = new AsyncLocalStorage<RouterLogContext>();
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

function getOrCreateRequestId(request: Request): string {
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

export function runWithRouterLogContext<T>(
  options: RouterLogOptions,
  fn: () => T,
): T {
  if (!INTERNAL_RANGO_DEBUG) {
    return fn();
  }

  const requestId = getOrCreateRequestId(options.request);
  transactionCounter += 1;
  const transactionId = `${options.transaction}-${nextId("tx-", transactionCounter)}`;

  return routerLogContext.run(
    {
      requestId,
      transactionId,
      depth: 0,
    },
    fn,
  );
}

export function withRouterLogScope<T>(label: string, fn: () => Promise<T>): Promise<T>;
export function withRouterLogScope<T>(label: string, fn: () => T): T;
export function withRouterLogScope<T>(label: string, fn: () => Promise<T> | T): Promise<T> | T {
  const ctx = routerLogContext.getStore();
  if (!INTERNAL_RANGO_DEBUG || !ctx) {
    return fn();
  }

  debugLog(label, "start");

  return routerLogContext.run({ ...ctx, depth: ctx.depth + 1 }, () => {
    try {
      const result = fn();
      if (result && typeof (result as Promise<T>).then === "function") {
        return (result as Promise<T>).finally(() => {
          debugLog(label, "end");
        });
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
  if (!ctx) return `[Router][${scope}]`;
  const indent = "  ".repeat(ctx.depth);
  return `[Router][req:${ctx.requestId}][tx:${ctx.transactionId}] ${indent}[${scope}]`;
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
