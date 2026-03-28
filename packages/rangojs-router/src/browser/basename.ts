/**
 * Basename storage for href() and Link auto-prefixing.
 *
 * Browser: module-level variable via setBasename(), set once in initBrowserApp().
 * Server with async_hooks: AsyncLocalStorage via runWithBasename(), scoped per-request.
 * Server without async_hooks: module-level fallback via setBasename(), best-effort.
 *
 * Readers always call getBasename() which checks ALS first, then the global.
 */

// -- Module global (browser, and server fallback without async_hooks) --

let _globalBasename: string | undefined;

/**
 * Set basename in the module global. Used by:
 * - Browser: initBrowserApp() on initial load
 * - Server: SSR SsrRoot only when ALS is unavailable (fallback)
 */
export function setBasename(value: string | undefined): void {
  _globalBasename = value;
}

// -- AsyncLocalStorage (server only, lazy-initialized) --

let _als:
  | import("node:async_hooks").AsyncLocalStorage<string | undefined>
  | null = null;
let _alsChecked = false;

function als() {
  if (_alsChecked) return _als;
  _alsChecked = true;
  if (typeof window !== "undefined") return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod =
      require("node:async_hooks") as typeof import("node:async_hooks");
    _als = new mod.AsyncLocalStorage();
  } catch {
    // Edge runtimes without async_hooks — fall back to module global
  }
  return _als;
}

/** Whether ALS is available in this environment. */
export function hasAsyncStorage(): boolean {
  return als() !== null;
}

/**
 * Run a callback with basename scoped to this async context (server only).
 * Concurrent requests each get their own isolated basename value.
 * Falls back to set/restore of module global when ALS is unavailable.
 */
export function runWithBasename<T>(value: string | undefined, fn: () => T): T {
  const store = als();
  if (store) return store.run(value, fn);
  // Fallback for runtimes without async_hooks
  const prev = _globalBasename;
  _globalBasename = value;
  try {
    return fn();
  } finally {
    _globalBasename = prev;
  }
}

/** Read the current basename. ALS first (request-scoped), then global. */
export function getBasename(): string | undefined {
  const store = als();
  if (store) {
    const v = store.getStore();
    if (v !== undefined) return v || undefined;
  }
  return _globalBasename;
}
