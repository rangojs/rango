/**
 * Action fence: a refcounted flag that is raised while a server action is in
 * flight and lowered when it resolves.
 *
 * It replaces the eager cache clear the action bridge used to do at action
 * start. While the fence is up, the decision of whether the action invalidated
 * anything is deferred to the response:
 *
 * - prefetch consumption is suspended (a queued prefetch result is not served),
 * - a genuine navigation during the flight fetches with `cache: "no-store"` so
 *   it cannot be served stale bytes from the browser's Vary-keyed HTTP cache,
 * - popstate reads are treated as stale-while-revalidate.
 *
 * Nothing is wiped, rotated, or broadcast while the fence is up — that is what
 * keeps a sibling tab from seeing a pre-commit signal. Refcounted so concurrent
 * actions compose: each action raises and lowers its own reference, and the
 * fence is down only when the count reaches zero.
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
