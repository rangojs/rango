import { INTERNAL_RANGO_DEBUG } from "../internal-debug.js";

interface BrowserLogContext {
  requestId: string;
  txId: string;
  operation: string;
}

let txCounter = 0;
let requestCounter = 0;

export function isBrowserDebugEnabled(): boolean {
  return INTERNAL_RANGO_DEBUG;
}

function nextId(prefix: string, counter: number): string {
  return `${prefix}${counter.toString(36)}`;
}

export function startBrowserTransaction(operation: string): BrowserLogContext {
  txCounter += 1;
  requestCounter += 1;
  return {
    operation,
    txId: nextId("ctx-", txCounter),
    requestId: nextId("creq-", requestCounter),
  };
}

export function browserDebugLog(
  ctx: BrowserLogContext,
  message: string,
  details?: Record<string, unknown>,
): void {
  if (!INTERNAL_RANGO_DEBUG) return;

  const prefix = `[Browser][req:${ctx.requestId}][tx:${ctx.operation}-${ctx.txId}]`;
  if (details) {
    console.log(`${prefix} ${message}`, details);
    return;
  }

  console.log(`${prefix} ${message}`);
}

/**
 * Simple gated console.log for browser-side debug output.
 * Unlike browserDebugLog, this doesn't require a transaction context -
 * use it for standalone debug messages in partial-update, navigation-bridge, etc.
 */
export function debugLog(msg: string, ...args: unknown[]): void {
  if (INTERNAL_RANGO_DEBUG) {
    console.log(msg, ...args);
  }
}
