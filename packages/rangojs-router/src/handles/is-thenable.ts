/**
 * Single thenable predicate shared by the built-in handles that distinguish a
 * synchronous descriptor/item from a deferred `Promise` one (Meta collect, the
 * MetaTags render side, and Breadcrumbs).
 *
 * Requires a CALLABLE `then` (`typeof obj.then === "function"`), not merely a
 * `"then" in obj` membership check. The two had drifted: a descriptor carrying a
 * non-callable `then` (e.g. a serialized shape `{ then: 5 }`) was classified as
 * synchronous by collect but as a Promise by render — so render would call
 * React's `use()` on a non-thenable and throw. One owner keeps the collect and
 * render sides from ever disagreeing.
 */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
