// ============================================================================
// Tag-marker memo
// ============================================================================
//
// Per-request memoization of tag-invalidation marker reads, plus the prefix and
// sentinel used by the optional per-colo L1 marker cache. Extracted from
// cf-cache-store.ts; the WeakMaps stay MODULE SINGLETONS here (the module is
// evaluated once), so binding-keyed memo semantics are unchanged: the maps are
// keyed by the request-context object then the store INSTANCE, identical to
// before the move.

/**
 * Cache-API path prefix for the optional per-colo L1 cache of tag-invalidation
 * markers (enabled by tagCacheTtl). Distinct from data keys (doc:/fn:/segment)
 * and from the KV marker prefix so the two never collide.
 */
export const TAG_MARKER_CACHE_PREFIX = "__tagmarker__/";

/**
 * Sentinel body for an L1-cached marker meaning "this tag has no invalidation
 * marker." Distinct from any real ms-epoch timestamp (always a large positive
 * integer). A Cache API miss (match() === undefined) always means "re-read KV",
 * never "no marker" - absence is only ever represented by this cached sentinel.
 */
export const TAG_MARKER_ABSENT = "none";

/**
 * Per-request memo of tag-invalidation markers (tag -> latest invalidatedAt, or
 * null when no marker exists). Keyed first by the request context object (so it
 * is naturally request-scoped and garbage-collected with the request) and then
 * by the store INSTANCE.
 *
 * The per-store nesting matters because a single request can run more than one
 * CFCacheStore - the app-level store plus a route's `cache({ store })` override,
 * which may point at a DIFFERENT KV binding or version. A module-level map keyed
 * by request alone (the inner map keyed by the raw tag name) would let store B's
 * memoized marker for a tag mask store A's own KV marker, so A could serve an
 * entry A's own KV says is invalidated. Keying by the instance isolates them;
 * two reads through the SAME store still share the memo. A read through one
 * store never populates another's memo, so each store always consults its own KV
 * binding. Markers are read only through isGloballyInvalidated(), which already
 * short-circuits when a store has no KV, so a store without KV never allocates.
 *
 * Without the memo, isGloballyInvalidated() issues a KV read per tag on every
 * tagged cache read, so a page composed of many segments/items sharing a tag
 * pays that cost N times. The memo collapses it to one KV read per distinct tag
 * per (request, store). invalidateTags() writes through so a same-request
 * updateTag() stays read-your-own-writes consistent (the action's own re-render
 * sees its own invalidation from the memo, without a re-read).
 *
 * It does NOT span requests, so a hot single-entry route still pays one KV read
 * per request; that read hits Cloudflare KV's own edge read cache for hot keys.
 */
const tagMarkerMemo = new WeakMap<
  object,
  WeakMap<object, Map<string, number | null>>
>();

export function getTagMarkerMemo(
  ctx: object,
  store: object,
): Map<string, number | null> {
  let byStore = tagMarkerMemo.get(ctx);
  if (!byStore) {
    byStore = new WeakMap();
    tagMarkerMemo.set(ctx, byStore);
  }
  let memo = byStore.get(store);
  if (!memo) {
    memo = new Map();
    byStore.set(store, memo);
  }
  return memo;
}

/**
 * Per-request map of IN-FLIGHT marker reads (tag -> the pending read promise).
 * The resolved-value memo above only collapses SEQUENTIAL reads of a tag; the
 * router resolves sibling segments in PARALLEL, so without this several
 * concurrently-resolving segments sharing a tag would each issue their own KV
 * read before any of them populates the memo. Sharing the in-flight promise
 * collapses those to a single KV read. Entries are dropped once resolved (the
 * value is then in the memo), so this only spans the concurrent read window.
 */
const tagMarkerInflight = new WeakMap<
  object,
  WeakMap<object, Map<string, Promise<number | null>>>
>();

export function getTagMarkerInflight(
  ctx: object,
  store: object,
): Map<string, Promise<number | null>> {
  let byStore = tagMarkerInflight.get(ctx);
  if (!byStore) {
    byStore = new WeakMap();
    tagMarkerInflight.set(ctx, byStore);
  }
  let inflight = byStore.get(store);
  if (!inflight) {
    inflight = new Map();
    byStore.set(store, inflight);
  }
  return inflight;
}
