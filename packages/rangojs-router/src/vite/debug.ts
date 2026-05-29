/**
 * Debug logging for the Rango Vite plugin.
 *
 * Thin wrapper over the `debug` package (the same one Vite uses for its
 * own `vite:*` namespaces). Enable with either:
 *
 *     DEBUG='rango:*' vite dev
 *     vite --debug rango:*          # vite prepends `vite:`, we bridge it
 *
 * Returns `undefined` when no matching namespace is enabled, so call sites
 * can guard expensive diagnostics with a simple truthiness check:
 *
 *     const debug = createRangoDebugger(NS.routes);
 *     if (debug) debug("built manifest (%d routes) in %dms", n, ms);
 *
 * Back-compat: INTERNAL_RANGO_DEBUG=1 still enables all rango namespaces.
 *
 * Vite CLI note: `vite --debug <feat>` rewrites to `DEBUG=vite:<feat>` — it
 * always prefixes with `vite:` and cannot enable bare `rango:*` namespaces.
 * We work around this by registering a shadow `vite:rango:*` instance for
 * each debugger, so either invocation works.
 */

import debugFactory from "debug";

/**
 * Canonical debug namespaces. Import as `NS.xxx` instead of string literals
 * so typos become type errors and the full set lives in one place.
 */
export const NS = {
  config: "rango:config",
  discovery: "rango:discovery",
  routes: "rango:routes",
  prerender: "rango:prerender",
  build: "rango:build",
  dev: "rango:dev",
  transform: "rango:transform",
} as const;

// Back-compat: the legacy INTERNAL_RANGO_DEBUG env var enabled per-site
// console.logs in this plugin. Map it to `rango:*` so those call sites can
// be migrated to the `debug` pipeline without breaking existing setups.
// Uses debug.enable() rather than mutating process.env because the `debug`
// package already snapshotted DEBUG when it was imported above.
if (process.env.INTERNAL_RANGO_DEBUG) {
  const existing = debugFactory.disable();
  debugFactory.enable(existing ? `${existing},rango:*` : "rango:*");
}

export type Debugger = (formatter: string, ...args: unknown[]) => void;

export function createRangoDebugger(namespace: string): Debugger | undefined {
  const primary = debugFactory(namespace);
  // Shadow namespace so `vite --debug rango:*` (which expands to
  // DEBUG=vite:rango:*) and `vite --debug` (DEBUG=vite:*) both pick us up.
  const shadow = debugFactory(`vite:${namespace}`);
  if (primary.enabled) return primary as Debugger;
  if (shadow.enabled) return shadow as Debugger;
  return undefined;
}

/**
 * Measure an async block and log its duration via `debug`. No-ops (still
 * runs `fn`) when the namespace is disabled, so production cost is a single
 * `.enabled` check per call.
 *
 *     await timed(debug, "discover routers", () => discoverRouters(state));
 */
export async function timed<T>(
  debug: Debugger | undefined,
  label: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  if (!debug) return await fn();
  const start = performance.now();
  try {
    return await fn();
  } finally {
    debug("%s (%sms)", label, (performance.now() - start).toFixed(1));
  }
}

/**
 * Synchronous variant of `timed`. Use for sync call sites — wrapping them
 * with the async `timed` would create a floating promise that discards any
 * throw, bypassing the surrounding try/catch.
 */
export function timedSync<T>(
  debug: Debugger | undefined,
  label: string,
  fn: () => T,
): T {
  if (!debug) return fn();
  const start = performance.now();
  try {
    return fn();
  } finally {
    debug("%s (%sms)", label, (performance.now() - start).toFixed(1));
  }
}

/**
 * Aggregate counter for high-frequency call sites (typically Vite
 * `transform` hooks that run on many files). Per-call logging would
 * drown real signal; this collects totals and reports once on flush.
 *
 *     const counter = createCounter(debug, "use-cache-transform");
 *     // inside transform():
 *     return counter?.time(id, () => doWork()) ?? doWork();
 *     // or manually:
 *     counter?.record(id, ms);
 *     // flush on buildEnd (counter resets, so multi-env builds each get
 *     // their own summary line):
 *     counter?.flush();
 *
 * Returns `undefined` when the namespace is disabled so call sites pay
 * nothing when off.
 */
export interface Counter {
  record(file: string, ms: number): void;
  /**
   * Convenience: time a sync or async block and record it. Propagates
   * throws; records regardless of outcome. Returns the function's result.
   */
  time<T>(file: string, fn: () => T): T;
  time<T>(file: string, fn: () => Promise<T>): Promise<T>;
  flush(): void;
}

export function createCounter(
  debug: Debugger | undefined,
  label: string,
): Counter | undefined {
  if (!debug) return undefined;
  let n = 0;
  let totalMs = 0;
  let slowestMs = 0;
  let slowestFile = "";
  const record = (file: string, ms: number): void => {
    n++;
    totalMs += ms;
    if (ms > slowestMs) {
      slowestMs = ms;
      slowestFile = file;
    }
  };
  return {
    record,
    time<T>(file: string, fn: () => T | Promise<T>): T | Promise<T> {
      const start = performance.now();
      let out: T | Promise<T>;
      try {
        out = fn();
      } catch (err) {
        record(file, performance.now() - start);
        throw err;
      }
      if (out && typeof (out as any).then === "function") {
        return (out as Promise<T>).finally(() =>
          record(file, performance.now() - start),
        );
      }
      record(file, performance.now() - start);
      return out;
    },
    flush(): void {
      if (n === 0) return;
      debug(
        "%s: %d files, %sms total, slowest %sms %s",
        label,
        n,
        totalMs.toFixed(1),
        slowestMs.toFixed(1),
        slowestFile,
      );
      // Reset so buildEnd firing once per environment (Vite 6+ multi-env)
      // gives one log line per env rather than silently dropping later data.
      n = 0;
      totalMs = 0;
      slowestMs = 0;
      slowestFile = "";
    },
  };
}
