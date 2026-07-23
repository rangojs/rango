// ============================================================================
// Constants
// ============================================================================
//
// Header names, KV prefixes, and timeout/interval defaults for the CF cache
// store. Extracted from cf-cache-store.ts so the constants can be shared by the
// store and its sibling collaborator modules without a circular import back to
// the class. The public ones (CACHE_*_HEADER, TAG_MARKER_PREFIX,
// MAX_REVALIDATION_INTERVAL, EDGE_*_TIMEOUT_MS, KV_READ_TIMEOUT_MS) are
// re-exported from cf-cache-store.ts so existing import paths still resolve.

/** Header storing timestamp when entry becomes stale */
export const CACHE_STALE_AT_HEADER = "x-edge-cache-stale-at";

/** Header storing cache status: HIT | REVALIDATING */
export const CACHE_STATUS_HEADER = "x-edge-cache-status";

/**
 * Header storing this entry's cache tags as a JSON array. JSON-encoded (not the
 * comma-delimited CF `Cache-Tag` format) so tags containing commas round-trip
 * safely; the read paths parse this to run the tag-invalidation check.
 */
export const CACHE_TAGS_HEADER = "x-edge-cache-tags";

/** Header storing the ms-epoch timestamp when this entry's tags were attached. */
export const CACHE_TAGGED_AT_HEADER = "x-edge-cache-tagged-at";

/**
 * KV key prefix for tag-invalidation markers. A marker stores the ms-epoch
 * timestamp of the most recent invalidation of a tag; reads treat any entry
 * whose taggedAt is older than its tags' latest marker as invalidated. Markers
 * live in the SAME KV namespace as the cached entries - there is no separate
 * tag-invalidation store.
 */
export const TAG_MARKER_PREFIX = "__tag__/";

/**
 * Header storing the epoch-ms timestamp when an entry was marked REVALIDATING.
 * The SWR thundering-herd guard reads this to decide whether the in-flight
 * revalidation is still recent. It replaces a prior reliance on the HTTP `Age`
 * header: CF's Cache API does not populate `Age` reliably per-colo (and our own
 * unit MockCache never set it), so an absent `Age` defaulted to 0 and made every
 * REVALIDATING entry look "just revalidated" forever -- a dropped/never-finished
 * background revalidation could then pin an entry stale until hard expiry. An
 * explicit timestamp we write ourselves (same pattern as CACHE_STALE_AT_HEADER)
 * is reliable and lets the MAX_REVALIDATION_INTERVAL re-arm actually fire.
 */
export const CACHE_REVALIDATING_AT_HEADER = "x-edge-cache-revalidating-at";

/**
 * Header storing the absolute epoch-ms hard-expiry deadline (staleAt +
 * swrWindow*1000) of an L1 entry. The stale-path REVALIDATING re-put reads this
 * to recompute a SHRINKING Cache-Control max-age instead of copying set()'s
 * original full-window max-age. Without it, every MAX_REVALIDATION_INTERVAL
 * re-arm re-puts the full window and restarts CF's retention clock, pinning a
 * perpetually-stale entry (one whose background revalidation keeps failing) past
 * its intended hard-expiry indefinitely. Mirrors the KVSegmentEnvelope `e`
 * field and the remaining-ttl math in promoteSegmentToL1/promoteItemToL1.
 * @internal
 */
export const CACHE_EXPIRES_AT_HEADER = "x-edge-cache-expires-at";

/**
 * Header stashing the route author's original Cache-Control on L1 document
 * entries. putResponse/promoteResponseToL1 overwrite Cache-Control with a long
 * `max-age` so the CF Cache API retains the entry across the whole SWR window;
 * getResponse restores this original value before serving so the client and any
 * upstream CDN see the author's intended directive, not the internal edge TTL.
 */
export const CACHE_ORIG_CC_HEADER = "x-edge-cache-orig-cc";

/**
 * Maximum age in seconds for REVALIDATING status before allowing new revalidation.
 * After this period, a stale entry in REVALIDATING status will trigger revalidation again.
 * @internal
 */
export const MAX_REVALIDATION_INTERVAL = 30;

/**
 * Maximum time (ms) to wait for an L1 edge cache (CF Cache API) read before
 * giving up and treating it as a miss. The Cache API is normally sub-millisecond
 * per-colo, so a slow `match` signals a degraded colo; we don't want it adding
 * latency to the request. On timeout the lookup is abandoned, a warning is
 * logged, and the read falls through to its normal miss path (L2/KV or render).
 *
 * This is the default; override per store via
 * `CFCacheStoreOptions.edgeLookupTimeoutMs` (<= 0 disables the budget).
 *
 * 25ms, raised from 10: production Workers logs (autobarn pilot) showed the
 * 10ms budget firing frequently on cold colos where the first Cache API touch
 * is slow but healthy — each false positive downgrades a warm L1 HIT to an
 * L2/render round trip that costs far more than the 15ms of extra patience.
 * A genuinely degraded colo still gets cut off; tune per store for
 * shell-critical routes.
 */
export const EDGE_LOOKUP_TIMEOUT_MS = 25;

/**
 * Maximum time (ms) to wait for the BODY of a matched L1 entry to be read
 * (response.json()) before treating the read as a miss.
 *
 * This is separate from {@link EDGE_LOOKUP_TIMEOUT_MS} on purpose. CF's Cache
 * API resolves `match()` with a lazily-streamed body, so a fast `match` can be
 * followed by a multi-second stall while the body bytes are fetched -- the
 * latency tail lives here, after the match budget has already passed. The
 * default bounds that tail aggressively: a healthy per-colo body read (fetch +
 * JSON parse) settles in low single-digit milliseconds, so 20ms clears a
 * healthy read while still failing fast to L2/KV (or render) on a degraded colo
 * instead of pinning the request behind a seconds-long read. Raise it per store
 * if large Flight payloads legitimately need longer.
 *
 * Override per store via `CFCacheStoreOptions.edgeReadTimeoutMs` (<= 0 disables).
 */
export const EDGE_READ_TIMEOUT_MS = 20;

/**
 * Maximum time (ms) to wait for an L2 (KV) read (`kv.get(key, {type:"json"})`)
 * before treating it as a miss. Unlike the L1 budgets, KV is a GLOBAL store: the
 * file header documents ~50ms healthy reads, and a degraded namespace can tail
 * to seconds. KV is the LAST cache tier before a full render, so an unbounded
 * read here pins the whole request behind a degraded global lookup.
 *
 * The default (170ms) sits a few multiples above the documented ~50ms healthy
 * read, leaving headroom for legitimate latency tails (larger payloads,
 * far-from-colo regions) so a healthy-but-slow read does not false-miss into a
 * render, while still abandoning a genuinely degraded namespace well before its
 * multi-second tail can pin the request. A deployment with a tighter SLA can
 * lower it, and one whose healthy p99 runs higher should raise it: measure the
 * KV read p99 (Workers Analytics) and add margin. It is a degradation
 * guard-rail, not a tuning lever for "slow KV is normal here".
 *
 * Override per store via `CFCacheStoreOptions.kvReadTimeoutMs` (<= 0 disables).
 */
export const KV_READ_TIMEOUT_MS = 170;
