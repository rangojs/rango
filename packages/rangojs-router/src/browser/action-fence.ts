/**
 * Action fence: a refcounted flag that is raised while a server action is in
 * flight and lowered when it resolves.
 *
 * It replaces the eager cache clear the action bridge used to do at action
 * start. While the fence is up, the decision of whether the action invalidated
 * anything is deferred to the response:
 *
 * - a navigation during the flight is an ordinary one: a prefetch is served,
 *   and the page it commits may hold pre-write data until the follow-up below,
 * - a navigation without a prefetch, and a prefetch, fetch with
 *   `cache: "no-store"` so they cannot be served stale bytes from the
 *   browser's Vary-keyed HTTP cache,
 * - popstate reads are treated as stale-while-revalidate.
 *
 * Nothing is wiped, rotated, or broadcast while the fence is up — that is what
 * keeps a sibling tab from seeing a pre-commit signal. Refcounted so concurrent
 * actions compose: each action raises and lowers its own reference, and the
 * fence is down only when the count reaches zero.
 *
 * The drop runs the batch's follow-up: when an action of the batch did not
 * land on the page on screen, the action bridge refetches that page once,
 * whole, after the navigation the user started, unless an intercept is on
 * screen (server-action-bridge.ts followUp; the rules are R1-R7 in
 * docs/internal/execution-model.md).
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

/** Test-only: reset the refcount between cases. */
export function __resetActionFence(): void {
  fenceCount = 0;
}
