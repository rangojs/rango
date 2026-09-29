// ============================================================================
// Tag-marker memo
// ============================================================================
//
// CFCacheStore's per-request tag-marker state: the data families' marker memo
// and in-flight reads, the PPR shell read's own marker record, and the prefix
// and sentinel of the optional per-colo L1 marker cache. The maps are module
// singletons keyed by the request-context object, then the store INSTANCE.

import type { MarkerMemoOutcome } from "../isolate-tag-memo.js";

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
 * Request context -> store instance -> T, both levels weakly held. Also
 * VercelCacheStore's request tag mask (#973).
 */
export type PerRequestStoreMap<T> = WeakMap<object, WeakMap<object, T>>;

/** The value for (ctx, store), created on first use. */
export function perRequestStoreValue<T>(
  map: PerRequestStoreMap<T>,
  ctx: object,
  store: object,
  create: () => T,
): T {
  let byStore = map.get(ctx);
  if (!byStore) {
    byStore = new WeakMap();
    map.set(ctx, byStore);
  }
  let value = byStore.get(store);
  if (value === undefined) {
    value = create();
    byStore.set(store, value);
  }
  return value;
}

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
 * binding. Markers are read through isGloballyInvalidated(), which
 * short-circuits when a store has no KV — and, in purge mode, through
 * isL1Invalidated(), which consults ONLY this memo on an L1 hit (no KV read),
 * so a purge-mode store allocates the memo even without KV for same-request
 * read-your-own-writes after updateTag()/revalidateTag().
 *
 * Without the memo, isGloballyInvalidated() issues a KV read per tag on every
 * tagged cache read, so a page composed of many segments/items sharing a tag
 * pays that cost N times. The memo collapses it to one KV read per distinct tag
 * per (request, store). invalidateTags() writes the new marker here before its
 * first await (maskRequestTags, #973), so the request that ran updateTag() or
 * revalidateTag() reads its own writes: the action's own re-render sees its
 * invalidation from the memo, without waiting for the KV put that
 * revalidateTag() leaves to waitUntil.
 *
 * It does NOT span requests, so a hot single-entry route still pays one KV read
 * per request; that read hits Cloudflare KV's own edge read cache for hot keys.
 * A context derived from the request (Object.create(reqCtx): a PPR HIT tail, a
 * shell capture) keeps a memo of its own, so its marker reads stay its own; it
 * starts from the request's mask (requestMasks) instead of empty, and takes
 * every mask the request sets later (requestMemos).
 */
const tagMarkerMemo: PerRequestStoreMap<Map<string, number | null>> =
  new WeakMap();

/**
 * The tags each request invalidated through each store, with the
 * invalidatedAt its mask carries (#973). Keyed by the request's root context
 * (RequestContext._requestRoot) rather than by the context that called, so a
 * derived context sees the request's mask and a mask it sets reaches the
 * request. Its values are unconfirmed until the KV put lands: a marker read
 * that finds one of them publishes nothing to other requests
 * (CFCacheStore.fetchTagMarker).
 */
const requestMasks: PerRequestStoreMap<Map<string, number>> = new WeakMap();

/**
 * Every memo of a request, whichever context owns it, per (root, store): a
 * mask set later reaches the memos that already exist (maskRequestTags), not
 * only the caller's. They live as long as the request does.
 */
const requestMemos: PerRequestStoreMap<Set<Map<string, number | null>>> =
  new WeakMap();

function requestRoot(ctx: object): object {
  return (ctx as { _requestRoot?: object })._requestRoot ?? ctx;
}

export function getTagMarkerMemo(
  ctx: object,
  store: object,
): Map<string, number | null> {
  return perRequestStoreValue(tagMarkerMemo, ctx, store, () => {
    const root = requestRoot(ctx);
    const memo = new Map<string, number | null>(
      requestMasks.get(root)?.get(store),
    );
    perRequestStoreValue(requestMemos, root, store, () => new Set()).add(memo);
    return memo;
  });
}

/**
 * Mask `tags` at `at` for the rest of the request: in the request's mask and
 * in every memo the request's contexts hold for `store` (a memo created later
 * starts from the mask).
 */
export function maskRequestTags(
  ctx: object,
  store: object,
  tags: readonly string[],
  at: number,
): void {
  const root = requestRoot(ctx);
  const mask = perRequestStoreValue(
    requestMasks,
    root,
    store,
    () => new Map<string, number>(),
  );
  getTagMarkerMemo(ctx, store);
  const memos = requestMemos.get(root)?.get(store) ?? [];
  for (const tag of tags) {
    mask.set(tag, at);
    for (const memo of memos) memo.set(tag, at);
  }
}

/** Whether this request masked `tag` through `store` (maskRequestTags). */
export function isRequestMasked(
  ctx: object,
  store: object,
  tag: string,
): boolean {
  return requestMasks.get(requestRoot(ctx))?.get(store)?.has(tag) ?? false;
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
const tagMarkerInflight: PerRequestStoreMap<
  Map<string, Promise<number | null>>
> = new WeakMap();

/**
 * A request's PPR shell-read marker reads (issue #941), kept apart from the
 * per-request memo above, HIT or MISS. A shell read may answer a marker from
 * the isolate marker memo (isolate-tag-memo.ts), up to `markerMaxStaleMs`
 * old; the data families must never see that value. Scar tissue: first the
 * shell read wrote into the per-request memo, so a MISS request rendered and
 * stored its `"use cache"` data under a stale marker; then a HIT copied its
 * entry's tags across, which a partial navigation's matchPartial (on the same
 * context as its replay gate's getShell) read, and a `cache()` segment it
 * wrote kept the stale item past `markerMaxStaleMs` under a fresh taggedAt.
 */
export interface ShellMarkerReads {
  /** The read of each tag, settled or in flight (collapses concurrent reads). */
  reads: Map<string, Promise<number | null>>;
  /** How the isolate memo answered each tag (the marker row's `memo=`). */
  outcomes: Map<string, MarkerMemoOutcome>;
}

const shellMarkerReads: PerRequestStoreMap<ShellMarkerReads> = new WeakMap();

export function getShellMarkerReads(
  ctx: object,
  store: object,
): ShellMarkerReads {
  return perRequestStoreValue(shellMarkerReads, ctx, store, () => ({
    reads: new Map(),
    outcomes: new Map(),
  }));
}

export function getTagMarkerInflight(
  ctx: object,
  store: object,
): Map<string, Promise<number | null>> {
  return perRequestStoreValue(tagMarkerInflight, ctx, store, () => new Map());
}
