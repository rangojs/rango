interface BrowserLogContext {
  requestId: string;
  txId: string;
  operation: string;
}

let debugEnabled = false;
let txCounter = 0;
let requestCounter = 0;

export function setBrowserDebugEnabled(enabled: boolean): void {
  debugEnabled = enabled;
}

export function isBrowserDebugEnabled(): boolean {
  return debugEnabled;
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
  if (!debugEnabled) return;

  const prefix = `[Browser][req:${ctx.requestId}][tx:${ctx.operation}-${ctx.txId}]`;
  if (details) {
    console.log(`${prefix} ${message}`, details);
    return;
  }

  console.log(`${prefix} ${message}`);
}
