/**
 * The per-request tag mask behind read-your-own-writes (#973).
 *
 * updateTag() and revalidateTag() call a store's invalidateTags() inside the
 * request, and a built-in store masks the tags here before its first await:
 * every later read in that request, through any context derived from it,
 * treats an entry carrying one of the tags, written at or before the mask, as
 * invalidated, without waiting for the durable write (the KV marker put, the
 * tag purge, expireTag()) that revalidateTag() leaves to waitUntil. The mask
 * only ever turns this request's hits into misses: if the durable write then
 * fails, the request paid extra misses, never a stale read, and other
 * requests read the durable state. CFCacheStore and VercelCacheStore share it.
 */

/** Request context -> store instance -> T, both levels weakly held. */
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
 * The request a context belongs to: RequestContext._requestRoot, which
 * createRequestContext defines and a derived context (Object.create: a shell
 * capture, a PPR HIT tail) inherits. A bare test context is its own root.
 */
export function requestRoot<T extends object>(
  ctx: T & { _requestRoot?: T },
): T {
  return ctx._requestRoot ?? ctx;
}

/** Request root -> store -> tag -> the invalidatedAt its mask carries. */
const requestMasks: PerRequestStoreMap<Map<string, number>> = new WeakMap();

/** Mask `tags` at `at` through `store` for the rest of `ctx`'s request. */
export function maskRequestTags(
  ctx: object,
  store: object,
  tags: readonly string[],
  at: number,
): void {
  const mask = perRequestStoreValue(
    requestMasks,
    requestRoot(ctx),
    store,
    () => new Map<string, number>(),
  );
  for (const tag of tags) mask.set(tag, at);
}

/**
 * Whether `ctx`'s request masked one of `tags` through `store` at or after
 * `taggedAt`. `>=`, as the stores' marker checks: an entry written in the
 * invalidation's millisecond may hold a value computed before it, so it
 * misses (a false miss, never a stale read).
 */
export function maskedForRequest(
  ctx: object | undefined,
  store: object,
  tags: readonly string[] | undefined,
  taggedAt: number,
): boolean {
  if (!ctx || !tags?.length) return false;
  const mask = requestMasks.get(requestRoot(ctx))?.get(store);
  if (!mask) return false;
  for (const tag of tags) {
    const at = mask.get(tag);
    if (at !== undefined && at >= taggedAt) return true;
  }
  return false;
}
