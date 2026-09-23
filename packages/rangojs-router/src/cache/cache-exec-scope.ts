/**
 * Execution-chain scope for "use cache" function bodies.
 *
 * The ambient guards (cookies(), headers(), ctx.set() reached via
 * getRequestContext()) must fire for code running INSIDE a cached body and
 * stay silent for everything else on the request. A property stamped on the
 * shared RequestContext cannot express that: while a slow "use cache" body is
 * in flight, every parallel read on the same request sees the stamp. Scar: a
 * 2s cached product fetch running beside a sibling loader made the loader's
 * cookies() read throw `cannot be called inside a "use cache" function` —
 * same shared-object hazard as issue #684 plan 010, which fixed only the
 * background-revalidation path. AsyncLocalStorage follows the cached body's
 * own async chain, so parallel work is invisible to the guard while genuine
 * in-body reads still throw.
 *
 * Deliberately NOT entered on the store-less bypass paths in cache-runtime.ts:
 * there the body executes for real on every call, side effects take effect,
 * and request-scoped reads are safe (see the bypass comments there).
 *
 * Kept separate from taint.ts so `node:async_hooks` stays out of that module —
 * taint.ts is reachable from browser-bundled DSL helpers. The probe
 * registration below wires assertNotInsideCacheExec to this scope without
 * taint.ts importing it.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { _setCacheExecScopeProbe } from "./taint.js";

/**
 * One "use cache" execution. Identity matters: the execution's handle capture
 * (cache-runtime.ts) records only pushes from its own chain, including cached
 * functions it calls (`parent` links them), not concurrent pushes into the
 * same request store.
 */
export interface CacheExecScope {
  readonly parent?: CacheExecScope;
}

const cacheExecStorage = new AsyncLocalStorage<CacheExecScope>();

/**
 * Run fn with the "use cache" execution scope active. Continuations spawned
 * from fn's synchronous kickoff inherit the scope; parallel chains do not.
 * Pass `scope` (createCacheExecScope) to test membership with
 * isInCacheExecChain.
 */
export function runWithCacheExecScope<T>(
  fn: () => T,
  scope: CacheExecScope = createCacheExecScope(),
): T {
  return cacheExecStorage.run(scope, fn);
}

/** A scope nested in the calling chain's current one, if any. */
export function createCacheExecScope(): CacheExecScope {
  return { parent: cacheExecStorage.getStore() };
}

/** True when the calling async chain is inside a "use cache" body. */
export function isInsideCacheExecScope(): boolean {
  return cacheExecStorage.getStore() !== undefined;
}

/** True when the calling async chain runs inside `scope`, at any depth. */
export function isInCacheExecChain(scope: CacheExecScope): boolean {
  for (let s = cacheExecStorage.getStore(); s; s = s.parent) {
    if (s === scope) return true;
  }
  return false;
}

// Wire the ambient ctx-method guards (assertNotInsideCacheExec in taint.ts)
// to this scope. Module-init registration cannot be missed: exec scopes only
// exist once cache-runtime.ts (which imports this module) is loaded.
_setCacheExecScopeProbe(isInsideCacheExecScope);
