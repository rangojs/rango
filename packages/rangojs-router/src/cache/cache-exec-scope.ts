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

// Global key: the value must survive HMR re-evaluation of this module, like
// the other request-scoped ALS instances (server/context.ts RangoContext).
const IDENTITY_EXEMPT_KEY = Symbol.for("rangojs-router:identity-exempt");
const identityExemptStorage: AsyncLocalStorage<boolean> = ((globalThis as any)[
  IDENTITY_EXEMPT_KEY
] ??= new AsyncLocalStorage<boolean>());

/**
 * Run a callback whose identity reads never reach a shared entry, so
 * guardIdentityRead (server/context.ts) lets them through and records
 * nothing (#976):
 *
 * - a cache's own decisions and metadata: a `key()`, a store `keyGenerator`
 *   (cache-policy.ts resolveCacheKey), a `condition()` (cache-scope.ts
 *   conditionAllows, loader-cache.ts) and a `tags()` function
 *   (cache-policy.ts resolveTagsOption). The value picks the entry, whether
 *   one is used, or how it is invalidated; it is never rendered. Reading the
 *   request there is the documented way to partition an entry;
 * - the router's `onError` (router/error-handling.ts invokeOnError): it
 *   observes, and a render error can reach it inside a capture or a cached
 *   scope.
 *
 * Scar: a ppr capture resolves its doc record key, and the record's tags,
 * again under the capture context; once `ctx.request.headers` was guarded, a
 * keyGenerator or tags() reading it refused every capture of the route.
 *
 * The exemption is async-local, so it would follow everything the callback
 * starts. A "use cache" body (runWithCacheExecScope), a loader body
 * (server/context.ts runInsideLoaderBodyScope) and a segment funnel
 * (getContext().runWithStore) end it on entry (endIdentityExempt). Scar: a
 * key() that awaited a "use cache" function reading cookies() stored the
 * first visitor's cookie and served it to the next.
 */
export function runIdentityExempt<T>(fn: () => T): T {
  return identityExemptStorage.run(true, fn);
}

/** True inside runIdentityExempt, and not in a scope started from it. */
export function isInsideIdentityExempt(): boolean {
  return identityExemptStorage.getStore() === true;
}

/** Run `fn` with the identity exemption ended (see runIdentityExempt). */
export function endIdentityExempt<T>(fn: () => T): T {
  return isInsideIdentityExempt() ? identityExemptStorage.run(false, fn) : fn();
}

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
  return endIdentityExempt(() => cacheExecStorage.run(scope, fn));
}

/** A scope nested in the calling chain's current one, if any. */
export function createCacheExecScope(): CacheExecScope {
  return { parent: cacheExecStorage.getStore() };
}

/** True when the calling async chain is inside a "use cache" body. */
export function isInsideCacheExecScope(): boolean {
  return cacheExecStorage.getStore() !== undefined;
}

/** The calling chain's innermost "use cache" scope, if any. */
export function getCacheExecScope(): CacheExecScope | undefined {
  return cacheExecStorage.getStore();
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
