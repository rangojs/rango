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

/**
 * A marker read the write gate issued (#977) and has not settled: the
 * store's answer for one tag and the millisecond it was issued in.
 */
interface GateRead {
  issuedAt: number;
  answer: Promise<unknown>;
}

/** Request root -> store -> tag -> the gate read in flight for it. */
const gateReads: PerRequestStoreMap<Map<string, GateRead>> = new WeakMap();

/**
 * A marker read for a write gate (isTagsInvalidatedSince, from
 * tag-invalidation.ts predatesInvalidation), shared by the gates of a
 * request that ask while it is in flight. A page's writes (its "use cache"
 * misses, its route record, its document) finish together and often carry
 * the same tags, and each read its own marker before: one KV or
 * runtime-cache read per tag per write.
 *
 * A read answers only for invalidations before it was issued. So a gate
 * shares one still in flight, issued at or after its execution started
 * (`sinceMs` is the millisecond after that start), and the read is dropped
 * once it settles: a gate asking later reads again, and a shared read
 * leaves open at most one marker round-trip. Reusing a settled read let a
 * gate asking long after it miss another isolate's invalidation in
 * between (a capture's putShell answered by a "use cache" write's read
 * from the start of the capture), and kept a timed-out read's fail-open
 * answer for the rest of the request. Without a request context `read()`
 * runs unshared.
 */
export function gateMarkerRead<T>(
  ctx: object | undefined,
  store: object,
  tag: string,
  sinceMs: number,
  read: () => Promise<T>,
): Promise<T> {
  if (!ctx) return read();
  const reads = perRequestStoreValue(
    gateReads,
    requestRoot(ctx),
    store,
    () => new Map<string, GateRead>(),
  );
  const inFlight = reads.get(tag);
  if (inFlight && inFlight.issuedAt >= sinceMs - 1) {
    return inFlight.answer as Promise<T>;
  }
  const answer = read();
  const entry: GateRead = { issuedAt: Date.now(), answer };
  reads.set(tag, entry);
  const settled = (): void => {
    if (reads.get(tag) === entry) reads.delete(tag);
  };
  answer.then(settled, settled);
  return answer;
}
