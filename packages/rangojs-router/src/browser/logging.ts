import { INTERNAL_RANGO_DEBUG } from "../internal-debug.js";

/**
 * Module-level debug flag for guarding call sites whose debug arguments do
 * non-trivial work (joins, maps, spreads, object literals). Because the Vite
 * transform folds INTERNAL_RANGO_DEBUG to a literal, an `if (IS_BROWSER_DEBUG)`
 * guard is minifier-DCE-able — the whole block drops from the production bundle.
 * Prefer this over isBrowserDebugEnabled() at hot call sites: a const guard folds
 * where a function call may not.
 */
export const IS_BROWSER_DEBUG: boolean = INTERNAL_RANGO_DEBUG;

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
