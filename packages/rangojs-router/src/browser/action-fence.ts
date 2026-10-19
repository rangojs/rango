/**
 * Action fence: a refcounted flag that is raised while a server action is in
 * flight and lowered when it resolves.
 *
 * It replaces the eager cache clear the action bridge used to do at action
 * start. While the fence is up, the decision of whether the action invalidated
 * anything is deferred to the response:
 *
 * - every request but an HMR refetch is stale (`_rsc_stale`,
 *   navigation-client.ts),
 * - an in-flight prefetch is not adopted (navigation-client.ts),
 * - a genuine navigation during the flight fetches with `cache: "no-store"` so
 *   it cannot be served stale bytes from the browser's Vary-keyed HTTP cache,
 * - popstate reads are treated as stale-while-revalidate.
 *
 * Nothing is wiped, rotated, or broadcast while the fence is up — that is what
 * keeps a sibling tab from seeing a pre-commit signal. Refcounted so concurrent
 * actions compose: each action raises and lowers its own reference, and the
 * fence is down only when the count reaches zero.
 *
 * The refcount is a single module-level counter, not keyed by routerId.
 * Consumers (navigation-client.ts, prefetch/fetch.ts, navigation-bridge.ts)
 * read it unscoped, so an action in one router would suppress another router's
 * navigation/prefetch caches. This is correct only because two routers cannot
 * coexist in one live document: an SPA navigation crossing a host-router
 * boundary forces a full document reload (src/router/request-classification.ts
 * app-switch terminal), so there is always exactly one live router per
 * document. A future multi-router-in-one-document feature must not silently
 * inherit this global, cross-router cache suppression.
 */

let fenceCount = 0;

export function enterActionFence(): void {
  fenceCount++;
}

export function exitActionFence(): void {
  if (fenceCount > 0) fenceCount--;
}

export function isActionFenceActive(): boolean {
  return fenceCount > 0;
}

/** Test-only: reset the fence between cases. */
export function __resetActionFence(): void {
  fenceCount = 0;
}
