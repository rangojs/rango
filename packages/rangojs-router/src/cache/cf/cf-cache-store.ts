/// <reference path="../../vite/plugins/version.d.ts" />

// Extend CacheStorage with Cloudflare's default cache property
declare global {
  interface CacheStorage {
    readonly default: Cache;
  }
}

/**
 * Cloudflare Edge Cache Store
 *
 * Production cache store using Cloudflare's Cache API (L1) with optional
 * KV persistence (L2).
 *
 * L1 (Cache API): Per-colo, fast, ephemeral. Handles SWR atomically.
 * L2 (KV): Global, persistent, ~50ms reads. Auto-warms cold colos.
 *
 * Read flow:  L1 hit → serve | L1 miss → L2 hit → serve + promote to L1 | both miss → render
 * Write flow: L1 write + L2 write (both via waitUntil)
 *
 * Features:
 * - Extended TTL for SWR window (max-age = ttl + swr)
 * - Staleness via x-edge-cache-stale-at header
 * - Atomic REVALIDATING status for thundering herd prevention (L1 only)
 * - Non-blocking writes via waitUntil
 * - KV L2 for cross-colo cache persistence
 */

import type {
  SegmentCacheStore,
  CachedEntryData,
  CacheDefaults,
  CacheGetResult,
  CacheItemResult,
  CacheItemOptions,
} from "../types.js";
import {
  _getRequestContext,
  type RequestContext,
} from "../../server/request-context.js";
import { VERSION } from "@rangojs/router:version";
import {
  isPerClientSignalHeader,
  stripPerClientSignals,
} from "../../browser/cookie-name.js";
import {
  resolveTtl,
  resolveSwrWindow,
  DEFAULT_FUNCTION_TTL,
} from "../cache-policy.js";
import { reportCacheError, reportingAsync } from "../cache-error.js";
import type { CacheErrorCategory } from "../cache-error.js";

// ============================================================================
// Constants
// ============================================================================

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
 * Cache-API path prefix for the optional per-colo L1 cache of tag-invalidation
 * markers (enabled by tagCacheTtl). Distinct from data keys (doc:/fn:/segment)
 * and from the KV marker prefix so the two never collide.
 */
const TAG_MARKER_CACHE_PREFIX = "__tagmarker__/";

/**
 * Sentinel body for an L1-cached marker meaning "this tag has no invalidation
 * marker." Distinct from any real ms-epoch timestamp (always a large positive
 * integer). A Cache API miss (match() === undefined) always means "re-read KV",
 * never "no marker" - absence is only ever represented by this cached sentinel.
 */
const TAG_MARKER_ABSENT = "none";

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
const CACHE_EXPIRES_AT_HEADER = "x-edge-cache-expires-at";

/**
 * Header stashing the route author's original Cache-Control on L1 document
 * entries. putResponse/promoteResponseToL1 overwrite Cache-Control with a long
 * `max-age` so the CF Cache API retains the entry across the whole SWR window;
 * getResponse restores this original value before serving so the client and any
 * upstream CDN see the author's intended directive, not the internal edge TTL.
 */
const CACHE_ORIG_CC_HEADER = "x-edge-cache-orig-cc";

/**
 * Maximum age in seconds for REVALIDATING status before allowing new revalidation.
 * After this period, a stale entry in REVALIDATING status will trigger revalidation again.
 * @internal
 */
export const MAX_REVALIDATION_INTERVAL = 30;

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

function getTagMarkerMemo(
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

function getTagMarkerInflight(
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

/** KV key byte-length ceiling. Cloudflare KV rejects keys larger than this. */
const KV_MAX_KEY_BYTES = 512;

/**
 * Cloudflare KV's minimum `expirationTtl` (seconds). A `put` with a smaller
 * expirationTtl is rejected outright. Tag-invalidation markers (the only writes
 * that take a consumer-supplied TTL via tagInvalidationTtl) are floored to this
 * so a too-small value cannot make EVERY updateTag/revalidateTag throw.
 */
const KV_MIN_EXPIRATION_TTL = 60;

const kvKeyEncoder = new TextEncoder();

/** UTF-8 byte length of a KV key (multibyte tags can exceed the char count). */
function kvKeyByteLength(key: string): number {
  return kvKeyEncoder.encode(key).length;
}

/**
 * Stores (by namespace) already warned about tag machinery configured without a
 * KV namespace, so the warning fires once per process rather than per request
 * (CFCacheStore is constructed per request).
 */
const warnedNoKvReadInvalidation = new Set<string>();

/**
 * Stores (by namespace) already warned about a tagInvalidationTtl below KV's
 * expirationTtl floor, so the floor warning fires once per process rather than
 * once per request (CFCacheStore is constructed per request).
 */
const warnedTagInvalidationTtlFloor = new Set<string>();

/**
 * Maximum time (ms) to wait for an L1 edge cache (CF Cache API) read before
 * giving up and treating it as a miss. The Cache API is normally sub-millisecond
 * per-colo, so a slow `match` signals a degraded colo; we don't want it adding
 * latency to the request. On timeout the lookup is abandoned, a warning is
 * logged, and the read falls through to its normal miss path (L2/KV or render).
 *
 * This is the default; override per store via
 * `CFCacheStoreOptions.edgeLookupTimeoutMs` (<= 0 disables the budget).
 */
export const EDGE_LOOKUP_TIMEOUT_MS = 10;

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

/**
 * Compute the Cache-Control directive for a stale-path REVALIDATING re-put from
 * the entry's stored hard-expiry deadline (CACHE_EXPIRES_AT_HEADER). Returns the
 * REMAINING ttl so the re-put preserves the original retention deadline instead
 * of restarting it -- copying set()'s original full-window max-age would reset
 * CF's retention clock on every re-arm and pin a perpetually-stale entry forever.
 * An entry lacking a valid deadline (legacy/tampered) floors to max-age=1, so it
 * hard-expires in ~1s and self-heals via KV. Mirrors promoteSegmentToL1's math.
 * @internal
 */
function remainingCacheControl(headers: Headers, now: number): string {
  const expiresAt = Number(headers.get(CACHE_EXPIRES_AT_HEADER));
  const remainingTtl =
    Number.isFinite(expiresAt) && expiresAt > 0
      ? Math.max(1, Math.floor((expiresAt - now) / 1000))
      : 1;
  return `public, max-age=${remainingTtl}`;
}

// ============================================================================
// Types
// ============================================================================

// Re-exported from the canonical home so cf-cache-store consumers keep
// importing `ExecutionContext` from this module without a second interface
// drifting over time.
export type { ExecutionContext } from "../../types/request-scope.js";
import type { ExecutionContext } from "../../types/request-scope.js";

/**
 * Minimal Cloudflare KV Namespace interface.
 * Avoids hard dependency on @cloudflare/workers-types.
 */
export interface KVNamespace {
  get(key: string, options?: { type?: string }): Promise<any>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * KV envelope for segment cache entries.
 * @internal
 */
interface KVSegmentEnvelope {
  /** Cached segment data */
  d: CachedEntryData;
  /** When entry becomes stale (ms epoch) */
  s: number;
  /** When entry hard-expires (ms epoch) */
  e: number;
}

/**
 * KV envelope for function cache entries ("use cache").
 * @internal
 */
interface KVItemEnvelope {
  /** RSC-serialized return value */
  v: string;
  /** RSC-encoded handle data (see handle-snapshot.ts encodeHandles) */
  h?: string;
  /** When entry becomes stale (ms epoch) */
  s: number;
  /** When entry hard-expires (ms epoch) */
  e: number;
  /** Cache tags (for distributed tag invalidation) */
  t?: string[];
  /** Timestamp when tags were attached (ms epoch) */
  ta?: number;
}

/**
 * KV envelope for document cache entries.
 * @internal
 */
interface KVResponseEnvelope {
  /** Response body as base64-encoded string (safe for binary payloads) */
  b: string;
  /** HTTP status code */
  st: number;
  /** HTTP status text */
  stx: string;
  /** Serialized headers as key-value pairs (client-facing; no internal headers) */
  hd: [string, string][];
  /** When entry becomes stale (ms epoch) */
  s: number;
  /** When entry hard-expires (ms epoch) */
  e: number;
  /** Cache tags (for distributed tag invalidation) */
  t?: string[];
  /** Timestamp when tags were attached (ms epoch) */
  ta?: number;
}

/**
 * One L1 read decision, surfaced when `debug` is enabled. Lets an operator
 * confirm on a real deployment (e.g. via `wrangler tail`) that the store's
 * observed inputs match its decision: which tier answered, the entry's status,
 * the stale/revalidating timestamps, the raw CF `Age` header (so its
 * unreliability can be seen next to the explicit revalidating-at stamp), and
 * the measured match/body-read durations (where the latency tail shows up).
 */
export interface CFCacheReadDebugEvent {
  /**
   * Which read method produced this event. Only the JSON read paths (segment
   * `get` and function `getItem`) participate in debug; the document
   * `getResponse` path streams its body and is intentionally out of scope.
   */
  op: "get" | "getItem";
  /** Cache key (without the internal fn:/doc: prefix or version path). */
  key: string;
  /**
   * What the read resolved to:
   * - l1-fresh / l1-stale-revalidate / l1-revalidating-guarded: L1 hit outcomes
   * - match-timeout / body-timeout: the L1 latency budgets fired
   * - match-error: the L1 match() itself rejected (a transient Cache API infra
   *   error) -- a miss that falls through to L2/KV and is reported cache-read,
   *   distinct from a genuine l1-miss (absence) so the two are separable
   * - body-error: the L1 body read failed fast (corrupt/non-JSON body) -- a miss
   *   that falls through to L2/KV, distinct from a body-timeout
   * - non-200: L1 returned a non-200 (treated as a miss)
   * - l1-miss: no L1 entry
   * - kv-fresh / kv-stale / kv-miss: L2 fallback outcomes
   * - kv-stale-suppressed: a stale L2 hit served WITHOUT revalidation because
   *   the L1 fall-through was degraded (body-timeout / non-200) -- the herd
   *   mitigation, distinct from kv-stale so the suppression is visible
   * - kv-timeout: the L2/KV read budget fired (read abandoned, NOT a genuine
   *   absence -- distinct from kv-miss so a degradation signal is separable)
   * - tag-invalidated: a live L1/KV entry whose cache tags were invalidated
   *   after it was written -- treated as a miss so the next render re-populates
   *   it (the tag-invalidation read path, distinct from a plain miss)
   * - error: the read threw
   */
  outcome:
    | "l1-fresh"
    | "l1-stale-revalidate"
    | "l1-revalidating-guarded"
    | "match-timeout"
    | "match-error"
    | "body-timeout"
    | "body-error"
    | "non-200"
    | "tag-invalidated"
    | "l1-miss"
    | "kv-fresh"
    | "kv-stale"
    | "kv-stale-suppressed"
    | "kv-miss"
    | "kv-timeout"
    | "error";
  /** HTTP status of the matched L1 response, when one was returned. */
  status?: number;
  /**
   * Stored cache status header (CACHE_STATUS_HEADER): "HIT" or "REVALIDATING".
   * Distinct from `isRevalidating`, which also factors in stamp recency -- this
   * is the raw stored value, so a REVALIDATING entry whose stamp aged out (so
   * `isRevalidating` is false) is still distinguishable from a plain HIT.
   */
  cacheStatus?: string | null;
  /** Epoch-ms when the entry goes stale (from CACHE_STALE_AT_HEADER). */
  staleAt?: number;
  /** Epoch-ms the entry was marked REVALIDATING (from the explicit stamp). */
  revalidatingAt?: number;
  /** Raw CF `Age` header, for comparison against revalidatingAt (may be null). */
  ageHeader?: string | null;
  isStale?: boolean;
  isRevalidating?: boolean;
  shouldRevalidate?: boolean;
  /** Wall-clock ms spent in cache.match (bounded by edgeLookupTimeoutMs). */
  matchMs?: number;
  /**
   * Wall-clock ms spent resolving the entry's tag-invalidation markers (the
   * per-request memo -> optional per-colo L1 marker cache -> KV cascade), for a
   * tagged entry. 0/absent for an untagged entry or a memo hit; a non-trivial
   * value is the serial marker-read tail that sits between matchMs and
   * bodyReadMs. Only measured when debug is enabled.
   */
  markerMs?: number;
  /** Wall-clock ms spent reading the body (bounded by edgeReadTimeoutMs). */
  bodyReadMs?: number;
}

/**
 * Debug sink. `true` logs each {@link CFCacheReadDebugEvent} to console; a
 * function receives the events for programmatic capture.
 */
export type CFCacheDebug = boolean | ((event: CFCacheReadDebugEvent) => void);

export interface CFCacheStoreOptions<TEnv = unknown> {
  /**
   * Cache namespace. If not provided, uses caches.default (recommended).
   * Only set this if you need isolated cache storage.
   */
  namespace?: string;

  /**
   * Base URL for cache keys.
   *
   * If not provided, derives from request hostname via requestContext:
   * - Production domains → uses `https://{hostname}/`
   * - Dev/preview (localhost, workers.dev, pages.dev) → uses internal fallback URL
   */
  baseUrl?: string;

  /** Default cache options */
  defaults?: CacheDefaults;

  /**
   * Cloudflare ExecutionContext for non-blocking cache writes.
   * Pass the `ctx` from your worker's fetch handler.
   *
   * @example
   * ```typescript
   * new CFCacheStore({ ctx: env.ctx })
   * ```
   */
  ctx: ExecutionContext;

  /**
   * Optional KV namespace for L2 cache persistence.
   *
   * When provided, KV acts as a global fallback behind the per-colo Cache API.
   * On L1 miss, KV is checked and hits are promoted back to L1.
   * On writes, data is persisted to both L1 and KV.
   *
   * @example
   * ```typescript
   * new CFCacheStore({ ctx: env.ctx, kv: env.CACHE_KV })
   * ```
   *
   * Tag-based invalidation (updateTag/revalidateTag) requires KV: the
   * tag-invalidation markers are stored in this same namespace. There is no
   * separate tag-invalidation store to configure.
   */
  kv?: KVNamespace;

  /**
   * Optional eager-purge hook, called ONCE per updateTag()/revalidateTag() with
   * the namespaced Cloudflare Cache-Tags to purge (one batched call for the
   * whole invalidation, not one per tag). These exactly match the `Cache-Tag`
   * header this store writes on its tag-lookup marker entries
   * (`rg:{namespace}:lk:{encodedTag}`), so forwarding them to Cloudflare's
   * purge-by-tag API evicts the cached lookups in every colo - making
   * cross-colo invalidation prompt instead of waiting out `tagCacheTtl`.
   *
   * Only meaningful with `tagCacheTtl > 0` (otherwise there are no cached
   * lookups to purge). The values are pre-encoded, so commas in tag names are
   * safe to pass straight to the purge API.
   *
   * @example
   * ```ts
   * onRevalidateTag: async (cacheTags) => {
   *   await fetch(`https://api.cloudflare.com/client/v4/zones/${ZONE}/purge_cache`, {
   *     method: "POST",
   *     headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
   *     body: JSON.stringify({ tags: cacheTags }),
   *   });
   * }
   * ```
   */
  onRevalidateTag?: (cacheTags: string[]) => Promise<void>;

  /**
   * Optional expiration (seconds) for tag-invalidation markers in KV. A marker
   * must outlive every entry tagged before the invalidation, so this MUST
   * exceed your largest entry TTL+SWR. Defaults to no expiration (markers
   * persist; they are tiny - one timestamp per distinct invalidated tag).
   *
   * Note the opposite sizing from `tagCacheTtl` below: `tagInvalidationTtl` must
   * be LARGE (outlive data); `tagCacheTtl` should be SMALL (a staleness ceiling).
   *
   * Cardinality matters: each DISTINCT invalidated tag writes one permanent KV
   * marker (with the no-expiry default). Keep tags LOW-cardinality and never
   * derive an invalidation tag from untrusted input (e.g.
   * `revalidateTag(req.query.tag)`) - an attacker could otherwise grow your KV
   * namespace without bound. Set a `tagInvalidationTtl` only if your tags are
   * unavoidably high-cardinality AND it can still safely exceed your max entry
   * TTL+SWR.
   */
  tagInvalidationTtl?: number;

  /**
   * Optional TTL (seconds) for caching tag-invalidation markers in the per-colo
   * Cache API (L1), to avoid a KV marker read on every tagged cache read.
   *
   * Default `0` = disabled: the marker is read from KV on every tagged read
   * (today's behavior), giving the strongest cross-colo invalidation latency
   * (~KV consistency). A positive value caches each marker (including the
   * "no marker yet" state) in L1 for that many seconds, so within the window a
   * colo answers from L1 with no KV read.
   *
   * The colo that runs `updateTag`/`revalidateTag` writes the fresh marker
   * straight into its own L1 (write-through), so the invalidating request and
   * later reads in that colo observe the invalidation immediately. One caveat: a
   * read already in flight when the invalidation lands (one that began its KV
   * marker fetch first) can re-cache the PRIOR marker into L1 after the
   * write-through, so a racing concurrent reader in the same colo may miss the
   * invalidation for up to `tagCacheTtl` -- the Cache API exposes no
   * compare-and-set to close this fully. `tagCacheTtl` is therefore a staleness
   * CEILING, not a promise of zero same-colo latency; keep it small (or wire
   * `onRevalidateTag`) when that matters. By default OTHER colos only converge
   * when their cached marker expires, so `tagCacheTtl` is the MAXIMUM extra
   * cross-colo invalidation latency for them. Recommended 30-60 for high-read,
   * low-mutation tags; leave at 0 when prompt global invalidation matters and
   * you cannot wire a purge.
   *
   * To make other colos prompt WITHOUT a short TTL, wire `onRevalidateTag` to a
   * Cloudflare purge-by-tag call: each marker entry carries a namespaced
   * `Cache-Tag`, and `onRevalidateTag` is handed exactly those tags to purge, so
   * the cached lookups are evicted everywhere on invalidation. With a purge
   * wired, `tagCacheTtl` becomes purely a read-cost reducer + fallback window
   * (safe to set large) rather than the invalidation-latency ceiling.
   */
  tagCacheTtl?: number;

  /**
   * Cache version string override. When this changes, all cached entries are
   * effectively invalidated (new keys won't match old entries).
   *
   * Defaults to the auto-generated VERSION from the `@rangojs/router:version` virtual module.
   * Only set this if you need a custom versioning strategy.
   */
  version?: string;

  /**
   * Latency budget (ms) for an L1 edge cache (CF Cache API) read. A `match`
   * slower than this is abandoned and treated as a miss, so a degraded colo
   * cannot stall the request; the read then falls through to its normal miss
   * path (L2/KV or render).
   *
   * Defaults to {@link EDGE_LOOKUP_TIMEOUT_MS} (10). Set to 0 (or any value
   * <= 0) to disable the budget and always await `match`.
   */
  edgeLookupTimeoutMs?: number;

  /**
   * Latency budget (ms) for reading the BODY of a matched L1 entry
   * (response.json()). CF streams the cache body lazily, so the multi-second
   * tail can appear after `match` already resolved; this bounds it. On timeout
   * the read is treated as a miss and falls through to L2/KV or render.
   *
   * Separate from {@link edgeLookupTimeoutMs} because a healthy body read
   * (fetch + JSON parse of a potentially large Flight payload) takes a little
   * longer than a `match`. Defaults to {@link EDGE_READ_TIMEOUT_MS} (20), which
   * clears a healthy per-colo read yet fails fast on a degraded one. Set to 0
   * (or any value <= 0) to disable and always await the body.
   */
  edgeReadTimeoutMs?: number;

  /**
   * Latency budget (ms) for an L2 (KV) read. KV is the last cache tier before a
   * full render and is a global store (~50ms healthy, seconds when degraded);
   * this bounds it so a slow namespace cannot pin the request. On timeout the
   * read is treated as a miss (no L1 promote) and falls through to render.
   *
   * Defaults to {@link KV_READ_TIMEOUT_MS} (170) -- a few multiples above the
   * ~50ms healthy read, with headroom for legitimate tails (large payloads / far
   * regions) yet still well under a degraded namespace's multi-second tail.
   * Lower it for a tighter SLA, raise it if your healthy KV p99 runs higher; it
   * is a degradation guard-rail, not a tuning lever. Set to 0 (or any value
   * <= 0) to disable and always await KV.
   */
  kvReadTimeoutMs?: number;

  /**
   * Emit a {@link CFCacheReadDebugEvent} per L1 read. `true` logs to console
   * (visible via `wrangler tail`); pass a function to capture events directly.
   * Off by default. Intended for validating cache behavior on a real
   * deployment before relying on it; not for steady-state production.
   */
  debug?: CFCacheDebug;

  /**
   * Custom key generator applied to all cache operations.
   * Receives the full RequestContext (including env) and the default-generated key.
   * Return value becomes the final cache key (unless route overrides with `key` option).
   *
   * Reserved prefixes: tag-invalidation markers live in the SAME KV namespace as
   * data, keyed `__tag__/<tag>` (and `__tagmarker__/<tag>` for the L1 cache). A
   * returned key must NOT begin with `__tag__/` or `__tagmarker__/`, or it can
   * collide with a tag marker and corrupt invalidation. The documented
   * prepend-style generators below are safe.
   *
   * @example Using headers for user segmentation
   * ```typescript
   * keyGenerator: (ctx, defaultKey) => {
   *   const segment = ctx.request.headers.get('x-user-segment') || 'default';
   *   return `${segment}:${defaultKey}`;
   * }
   * ```
   *
   * @example Using env bindings for multi-region
   * ```typescript
   * keyGenerator: (ctx, defaultKey) => {
   *   const region = ctx.env.REGION || 'us';
   *   return `${region}:${defaultKey}`;
   * }
   * ```
   *
   * @example Using cookies for locale-aware caching
   * ```typescript
   * keyGenerator: (ctx, defaultKey) => {
   *   const locale = cookies().get('locale')?.value || 'en';
   *   return `${locale}:${defaultKey}`;
   * }
   * ```
   */
  keyGenerator?: (
    ctx: RequestContext<TEnv>,
    defaultKey: string,
  ) => string | Promise<string>;
}

/**
 * Cache status values for the x-edge-cache-status header.
 * @internal
 */
export type CacheStatus = "HIT" | "REVALIDATING";

// ============================================================================
// CFCacheStore Implementation
// ============================================================================

export class CFCacheStore<TEnv = unknown> implements SegmentCacheStore<TEnv> {
  readonly defaults?: CacheDefaults;
  readonly keyGenerator?: (
    ctx: RequestContext<TEnv>,
    defaultKey: string,
  ) => string | Promise<string>;

  private readonly namespace?: string;
  private readonly explicitBaseUrl?: string;
  private readonly waitUntil?: (fn: () => Promise<void>) => void;
  private readonly version?: string;
  private readonly edgeLookupTimeoutMs: number;
  private readonly edgeReadTimeoutMs: number;
  private readonly kvReadTimeoutMs: number;
  private readonly debug?: (event: CFCacheReadDebugEvent) => void;
  private readonly kv?: KVNamespace;
  private readonly onRevalidateTag?: (tags: string[]) => Promise<void>;
  private readonly tagInvalidationTtl?: number;
  private readonly tagCacheTtl: number;

  constructor(options: CFCacheStoreOptions<TEnv>) {
    if (!options.ctx) {
      throw new Error(
        "[CFCacheStore] ExecutionContext (ctx) is required. " +
          "Pass the Cloudflare ExecutionContext from your worker's fetch handler: " +
          "new CFCacheStore({ ctx: env.ctx })",
      );
    }

    this.namespace = options.namespace;
    // Base URL is resolved lazily per cache operation (see resolveBaseUrl).
    // The store is constructed before the per-request context ALS is entered
    // (the cache factory runs ahead of runWithRequestContext in the handler),
    // so deriving the host here would always miss the request and fall back to
    // the internal host. Only the explicit override can be captured eagerly.
    this.explicitBaseUrl = options.baseUrl;
    this.defaults = options.defaults;
    this.version = options.version ?? VERSION;
    // Coalesce only finite numbers to the override; a non-finite value (NaN from
    // `Number(env.UNSET)`, or Infinity) would otherwise sail past `?? DEFAULT`
    // (which only replaces null/undefined) into setTimeout, where NaN/Infinity
    // are spec-coerced to ~1ms and silently turn the budget into a near-100%
    // false-miss on that tier. A genuine finite 0 or negative still passes
    // through and disables the budget per the documented `<= 0` contract.
    const finiteBudget = (
      value: number | undefined,
      fallback: number,
    ): number =>
      typeof value === "number" && Number.isFinite(value) ? value : fallback;
    this.edgeLookupTimeoutMs = finiteBudget(
      options.edgeLookupTimeoutMs,
      EDGE_LOOKUP_TIMEOUT_MS,
    );
    this.edgeReadTimeoutMs = finiteBudget(
      options.edgeReadTimeoutMs,
      EDGE_READ_TIMEOUT_MS,
    );
    this.kvReadTimeoutMs = finiteBudget(
      options.kvReadTimeoutMs,
      KV_READ_TIMEOUT_MS,
    );
    this.debug =
      options.debug === true
        ? (event) =>
            console.log(`[CFCacheStore:debug] ${JSON.stringify(event)}`)
        : typeof options.debug === "function"
          ? options.debug
          : undefined;
    this.keyGenerator = options.keyGenerator;
    this.waitUntil = (fn) => options.ctx.waitUntil(fn());
    this.kv = options.kv;
    this.onRevalidateTag = options.onRevalidateTag;
    // tagInvalidationTtl feeds KV's expirationTtl, which CF rejects below
    // KV_MIN_EXPIRATION_TTL (60s) -- a too-small finite value would make EVERY
    // marker write throw and break ALL invalidation. Floor it (and warn once);
    // a non-finite/non-positive value falls back to the no-expiry default
    // (markers persist) rather than silently sailing a NaN into expirationTtl.
    this.tagInvalidationTtl = this.sanitizeTagInvalidationTtl(
      options.tagInvalidationTtl,
    );
    // tagCacheTtl gates the L1 marker cache via `> 0`. A non-finite value (NaN
    // from `Number(env.UNSET)`) is not null/undefined, so `?? 0` would let it
    // through and silently disable the cache while reading as "configured".
    // Coerce any non-finite/non-positive value to the documented 0 = disabled.
    this.tagCacheTtl =
      typeof options.tagCacheTtl === "number" &&
      Number.isFinite(options.tagCacheTtl) &&
      options.tagCacheTtl > 0
        ? options.tagCacheTtl
        : 0;

    // Read-side tag invalidation requires KV: isGloballyInvalidated() compares an
    // entry's taggedAt against the per-tag KV marker and short-circuits to "not
    // invalidated" when no KV namespace is configured. A consumer who wires the
    // tag machinery (tagCacheTtl for L1 markers, or onRevalidateTag for CDN purge)
    // but omits kv gets only the purge fired - marker writes are skipped without
    // kv - yet every tagged read still serves stale data with no other signal.
    // Surface that misconfiguration.
    if (!this.kv && (this.tagCacheTtl > 0 || this.onRevalidateTag)) {
      const id = this.namespace ?? "default";
      if (!warnedNoKvReadInvalidation.has(id)) {
        warnedNoKvReadInvalidation.add(id);
        console.warn(
          `[CFCacheStore] tagCacheTtl/onRevalidateTag is configured without a KV ` +
            `namespace, so tag invalidation has NO read-side effect: tagged reads ` +
            `are never treated as invalidated and serve stale data. Configure ` +
            `{ kv } for distributed tag invalidation.`,
        );
      }
    }
  }

  /**
   * Validate a consumer-supplied tagInvalidationTtl against CF KV's expirationTtl
   * floor. A finite value below KV_MIN_EXPIRATION_TTL is raised to it (with a
   * one-time warning) so invalidation keeps working instead of every marker
   * write throwing; a non-finite or non-positive value returns undefined (the
   * no-expiry default). The warning still notes the sizing rule: the TTL must
   * exceed the largest entry TTL+SWR or invalidated entries can resurrect.
   * @internal
   */
  private sanitizeTagInvalidationTtl(
    value: number | undefined,
  ): number | undefined {
    if (value == null) return undefined;
    if (!Number.isFinite(value) || value <= 0) return undefined;
    if (value < KV_MIN_EXPIRATION_TTL) {
      const id = this.namespace ?? "default";
      if (!warnedTagInvalidationTtlFloor.has(id)) {
        warnedTagInvalidationTtlFloor.add(id);
        console.warn(
          `[CFCacheStore] tagInvalidationTtl ${value} is below Cloudflare KV's ` +
            `${KV_MIN_EXPIRATION_TTL}s expirationTtl floor; raising to ` +
            `${KV_MIN_EXPIRATION_TTL}. It must still exceed your largest entry ` +
            `TTL+SWR or invalidated entries can resurrect when the marker expires.`,
        );
      }
      return KV_MIN_EXPIRATION_TTL;
    }
    return value;
  }

  /**
   * Emit a debug event if `debug` is enabled. Swallows sink errors so a faulty
   * debug callback can never break a cache read.
   * @internal
   */
  private emitDebug(event: CFCacheReadDebugEvent): void {
    if (!this.debug) return;
    try {
      this.debug(event);
    } catch {
      // A broken debug sink must not affect the request.
    }
  }

  /**
   * Resolve the cache-key base URL for the current cache operation.
   * Prefers an explicit `baseUrl` option; otherwise derives it from the live
   * request. Called per operation (from keyToRequest), which runs inside the
   * request-context ALS, so deriveBaseUrl sees the request and can use the
   * production host instead of the internal fallback.
   * @internal
   */
  private resolveBaseUrl(): string {
    return this.explicitBaseUrl ?? this.deriveBaseUrl();
  }

  /**
   * Derive base URL from request hostname via requestContext.
   * Uses internal fallback for dev/preview environments and untrusted hostnames.
   * Must run inside the request context (invoked lazily via resolveBaseUrl).
   * @internal
   */
  private deriveBaseUrl(): string {
    const fallback = "https://rsc-dummy-host-1.com/";

    const ctx = _getRequestContext();
    if (!ctx?.request) {
      return fallback;
    }

    try {
      const url = new URL(ctx.request.url);
      const hostname = url.hostname;

      // Use fallback for dev/preview environments
      if (
        hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname.endsWith(".workers.dev") ||
        hostname.endsWith(".pages.dev")
      ) {
        return fallback;
      }

      // Validate hostname: must be a valid domain (alphanumeric, hyphens, dots)
      // to prevent host header injection into cache keys
      if (!/^[a-zA-Z0-9.-]+$/.test(hostname) || hostname.length > 253) {
        return fallback;
      }

      // Use actual hostname for production
      return `https://${hostname}/`;
    } catch {
      return fallback;
    }
  }

  /**
   * Get the cache instance - uses caches.default unless namespace is specified.
   * @internal
   */
  private getCache(): Cache | Promise<Cache> {
    if (this.namespace) {
      return caches.open(this.namespace);
    }
    return caches.default;
  }

  /**
   * Race an async cache read against a latency budget. Shared by all three read
   * tiers (L1 match, L1 body, L2/KV) so the timeout policy lives in one place:
   * on timeout it returns `{ value: undefined, timedOut: true }` and logs
   * `${label} exceeded ${budgetMs}ms; treating as miss`; the abandoned read is
   * left to settle in the background (late rejection swallowed) rather than
   * aborted, since the underlying CF primitives expose no cancellation. A budget
   * <= 0 disables the bound and awaits the read directly. `read` is a thunk so
   * the disabled path and the raced path start the read identically.
   * @internal
   */
  private async readWithTimeout<T>(
    read: () => Promise<T>,
    budgetMs: number,
    label: string,
  ): Promise<{ value: T | undefined; timedOut: boolean }> {
    if (budgetMs <= 0) return { value: await read(), timedOut: false };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ timedOut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), budgetMs);
    });
    try {
      const readPromise = read();
      // The losing branch keeps running; ensure a late rejection can't surface
      // as an unhandled rejection once we've stopped awaiting it.
      readPromise.catch(() => {});
      const result = await Promise.race([
        readPromise.then((value) => ({ timedOut: false as const, value })),
        timeout,
      ]);
      if (result.timedOut) {
        console.warn(
          `[CFCacheStore] ${label} exceeded ${budgetMs}ms; treating as miss`,
        );
        return { value: undefined, timedOut: true };
      }
      return { value: result.value, timedOut: false };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Read from the L1 edge cache under the edgeLookupTimeoutMs budget. A `match`
   * slower than the budget is abandoned and reported as a miss
   * (`{ response: undefined, timedOut: true }`) so a degraded colo cannot stall
   * the request; callers fall through to their normal miss path (L2/KV or
   * render). The `timedOut` flag lets callers distinguish an abandoned slow
   * match from a genuine miss for debug reporting; `error` is set when the
   * `match` itself rejected (a transient L1 infra error) so the caller can
   * report it as cache-read while still degrading to L2/KV -- distinct from a
   * genuine miss (no entry), which sets neither flag.
   * @internal
   */
  private async matchWithTimeout(
    cache: Cache,
    request: Request,
  ): Promise<{
    response: Response | undefined;
    timedOut: boolean;
    error?: unknown;
  }> {
    let matchError: unknown;
    const { value, timedOut } = await this.readWithTimeout(
      // A fast match rejection is caught at the thunk and reported as a miss
      // (response undefined), so the caller falls through to L2/KV rather than
      // escaping to the outer catch -- symmetric with the body-read thunk. The
      // error is captured (not swallowed) so the caller can surface it via
      // onError as a cache-read degradation.
      () =>
        cache.match(request).catch((e) => {
          matchError = e;
          return undefined;
        }),
      this.edgeLookupTimeoutMs,
      "edge cache lookup",
    );
    return { response: value, timedOut, error: matchError };
  }

  /**
   * Read and JSON-parse a matched L1 Response's body under the edgeReadTimeoutMs
   * budget. CF resolves `match()` with a lazily-streamed body, so the latency
   * tail surfaces here -- after matchWithTimeout has already passed -- not in the
   * match itself. On timeout `undefined` is returned so the caller falls through
   * to L2/KV or render.
   * @internal
   */
  private async readJsonWithTimeout<T>(
    response: Response,
  ): Promise<{ value: T | undefined; errored: boolean; error?: unknown }> {
    // A FAST json() rejection (a corrupt body, or a foreign 200 non-JSON
    // response that collided on this key) is caught at the thunk and turned into
    // a miss, so the caller falls through to L2/KV exactly like a body-timeout
    // -- instead of escaping to get()/getItem()'s outer catch, which returns
    // null WITHOUT ever consulting KV. The catch lives here, not in
    // readWithTimeout, so the L2/KV tier keeps propagating a genuine kv.get
    // rejection to its own error sink. The `errored` flag lets the caller emit a
    // distinct "body-error" debug outcome rather than masquerading as a timeout.
    // On a TIMEOUT the json() promise is still pending, so the catch has not
    // fired: errored stays false and the outcome is correctly a body-timeout. A
    // late rejection after the timeout only mutates the closure flag, which the
    // already-returned object no longer reads.
    let errored = false;
    let error: unknown;
    const { value } = await this.readWithTimeout<T | undefined>(
      () =>
        (response.json() as Promise<T>).catch((e) => {
          errored = true;
          error = e;
          return undefined;
        }),
      this.edgeReadTimeoutMs,
      "edge cache body read",
    );
    return { value, errored, error };
  }

  /**
   * Self-heal a corrupt L1 entry, then return the fall-through result. Reports
   * the corruption as cache-corrupt (so an onError consumer sees it distinctly
   * from a transient outage), runs the caller's L2/KV fall-through, and evicts
   * the faulty per-colo entry ONLY when that fall-through found no good copy.
   *
   * The conditional evict is the load-bearing detail: when KV DOES serve a copy,
   * kvGet* has already scheduled a same-key promote (`cache.put`); an eager
   * `cache.delete` here would race that put with no CF Cache API ordering
   * guarantee and could clobber the freshly-restored entry. So in that case we
   * lean on #558's heal-by-overwrite (the non-suppressed fall-through promotes /
   * a fresh render re-`set`s over the bad entry) and skip the delete. Only when
   * this request's fall-through found no copy (=== null) is the eager evict
   * scheduled -- useful then, since nothing else will overwrite the poison entry.
   * A null fall-through can also be a KV-read TIMEOUT rather than a genuine miss:
   * a concurrent request that read KV successfully may be promoting the same key,
   * and this evict could race it. That is benign -- the worst case is one wasted
   * colo-local promote, never a wrong served value, and the next read self-heals
   * -- so we accept it rather than suppressing the evict on a timeout (which
   * would strand the poison entry when KV really is empty). The evict is
   * non-blocking (waitUntil) so it never adds latency to the degraded read.
   * @internal
   */
  private async healCorruptL1<T>(
    cache: Cache,
    request: Request,
    error: unknown,
    label: string,
    fallThrough: () => Promise<T | null>,
  ): Promise<T | null> {
    reportCacheError(
      error ?? new Error("corrupt/partial L1 body"),
      "cache-corrupt",
      `[CFCacheStore] ${label}: corrupt L1 body`,
    );
    const result = await fallThrough();
    if (result === null) {
      const evict = (): Promise<void> =>
        reportingAsync(
          () => cache.delete(request),
          "cache-delete",
          `[CFCacheStore] ${label}: evict corrupt L1`,
        );
      if (this.waitUntil) this.waitUntil(evict);
      else void evict();
    }
    return result;
  }

  /**
   * Re-put a stale L1 entry marked REVALIDATING, so concurrent requests serve it
   * without each triggering a revalidation. Shared by get()/getItem().
   *
   * The write is NON-BLOCKING (waitUntil) and best-effort by design:
   * - It runs in waitUntil, so it never adds the put latency to the served stale
   *   read and a put failure can never turn that good read into a miss. The put
   *   is still initiated synchronously (this.waitUntil invokes its callback
   *   immediately), so concurrent readers see the marker land at the same time an
   *   awaited write would -- awaiting only blocks the current request.
   * - The background revalidation's fresh set() is gated behind a full re-render,
   *   so it lands well after this put; a stale-clobbers-fresh race would require
   *   this single put to be slower than that entire render+set, and self-heals
   *   within MAX_REVALIDATION_INTERVAL.
   *
   * Cache-Control is recomputed to the REMAINING ttl from the stored hard-expiry
   * deadline (see remainingCacheControl), not copied from the original
   * full-window header -- copying it would restart CF retention on every re-arm
   * and pin a perpetually-failing entry past hard-expiry. A legacy/tampered entry
   * without a valid deadline floors to max-age=1 and self-heals via KV.
   * @internal
   */
  private markRevalidating(
    cache: Cache,
    request: Request,
    sourceHeaders: Headers,
    status: number,
    body: string,
  ): void {
    const reputNow = Date.now();
    const headers = new Headers(sourceHeaders);
    headers.set(CACHE_STATUS_HEADER, "REVALIDATING");
    headers.set(CACHE_REVALIDATING_AT_HEADER, String(reputNow));
    headers.set("Cache-Control", remainingCacheControl(headers, reputNow));
    const markerResponse = new Response(body, { status, headers });
    const write = async (): Promise<void> => {
      try {
        await cache.put(request, markerResponse);
      } catch {
        // Best-effort: a failed marker write must not affect the served read;
        // the entry simply re-arms on the next stale read.
      }
    };
    if (this.waitUntil) this.waitUntil(write);
    else void write();
  }

  // ============================================================================
  // Segment Cache Methods
  // ============================================================================

  /**
   * Guard the segment tier against a `keyGenerator` that returns a key colliding
   * with a reserved tag-marker namespace: `__tag__/` (the KV marker key) or
   * `__tagmarker__/` (the L1 Cache API marker request). The item/doc tiers are
   * internally prefixed (`fn:`/`doc:`) so only the bare segment key can collide;
   * a collision would let a segment write clobber - or a segment read/delete
   * evict - a live tag marker, silently breaking invalidation. Report loudly
   * (so a misconfigured keyGenerator surfaces immediately) and treat the segment
   * operation as a miss/no-op rather than corrupting the marker namespace.
   * @internal
   */
  private isReservedSegmentKey(
    key: string,
    category: CacheErrorCategory,
  ): boolean {
    const reserved = key.startsWith(TAG_MARKER_PREFIX)
      ? TAG_MARKER_PREFIX
      : key.startsWith(TAG_MARKER_CACHE_PREFIX)
        ? TAG_MARKER_CACHE_PREFIX
        : null;
    if (!reserved) return false;
    reportCacheError(
      new Error(
        `segment key "${key}" collides with the reserved "${reserved}" ` +
          `tag-marker namespace; the operation is ignored. Fix the store ` +
          `keyGenerator so it does not produce keys with this prefix.`,
      ),
      category,
      "[CFCacheStore] reserved key",
    );
    return true;
  }

  /**
   * Get cached entry data by key.
   *
   * Handles SWR atomically:
   * - If stale and not already revalidating, marks as REVALIDATING and returns shouldRevalidate: true
   * - If already REVALIDATING (and recent), returns shouldRevalidate: false
   * - If fresh, returns shouldRevalidate: false
   *
   * On L1 miss, falls back to KV (L2) if configured.
   * KV hits are promoted to L1 in the background.
   */
  async get(key: string): Promise<CacheGetResult | null> {
    if (this.isReservedSegmentKey(key, "cache-read")) return null;
    try {
      const cache = await this.getCache();
      const request = this.keyToRequest(key);
      const matchStart = Date.now();
      const {
        response,
        timedOut,
        error: matchError,
      } = await this.matchWithTimeout(cache, request);
      const matchMs = Date.now() - matchStart;

      if (!response) {
        // A transient L1 match error (matchError set) is reported as cache-read
        // but, like a genuine miss or an abandoned slow match (timedOut), still
        // degrades to L2/KV rather than failing the read.
        if (matchError)
          reportCacheError(
            matchError,
            "cache-read",
            "[CFCacheStore] get L1 match",
          );
        if (this.debug)
          this.emitDebug({
            op: "get",
            key,
            // A match REJECTION (matchError) is distinct from a genuine absence:
            // surface it as match-error so debug agrees with the cache-read
            // already routed to onError, instead of masquerading as l1-miss.
            outcome: matchError
              ? "match-error"
              : timedOut
                ? "match-timeout"
                : "l1-miss",
            matchMs,
          });
        return this.kvGetSegment(key);
      }

      // A non-200 entry (a cached error response, or a foreign response that
      // landed on this key) is not valid segment data; treat it as a miss
      // rather than JSON-parsing garbage and serving it as a hit.
      if (response.status !== 200) {
        if (this.debug)
          this.emitDebug({
            op: "get",
            key,
            outcome: "non-200",
            status: response.status,
            matchMs,
          });
        // Degraded fall-through: suppress revalidation so a broken L1 entry hit
        // concurrently serves KV-stale, not a herd. See kvGetSegment.
        return this.kvGetSegment(key, { suppressRevalidate: true });
      }

      // Tag invalidation: an entry whose tags were invalidated after it was
      // cached is treated as a miss, so the next render re-populates it. We
      // return null (re-render locally) rather than falling through to KV. In
      // the common case the L1 entry and its KV twin were written together with
      // the same taggedAt, so kvGetSegment's own tag check would miss too and a
      // fall-through is pure cost. The tiers CAN diverge -- another colo may have
      // already re-rendered and written a fresher KV envelope -- in which case a
      // fall-through could serve that copy instead of re-rendering here.
      // Capturing that cross-colo optimization is a deferred follow-up, not a
      // correctness gap: this colo's next read after its own re-render self-heals.
      const tagInfo = this.readTagInfo(response.headers);
      // Measure the marker-resolution tail (memo -> L1 marker cache -> KV) only
      // when debug is on, so the hot path pays nothing. It is the serial read
      // that sits between matchMs and bodyReadMs for a tagged entry.
      const markerStart = this.debug ? Date.now() : 0;
      const invalidated = await this.isGloballyInvalidated(
        tagInfo.tags,
        tagInfo.taggedAt,
      );
      const markerMs = this.debug ? Date.now() - markerStart : undefined;
      if (invalidated) {
        if (this.debug)
          this.emitDebug({
            op: "get",
            key,
            outcome: "tag-invalidated",
            status: response.status,
            matchMs,
            markerMs,
          });
        return null;
      }

      // Read status headers
      const status = response.headers.get(CACHE_STATUS_HEADER);
      const staleAt = Number(
        response.headers.get(CACHE_STALE_AT_HEADER) ?? "0",
      );
      const revalidatingAt = Number(
        response.headers.get(CACHE_REVALIDATING_AT_HEADER) ?? "0",
      );

      const now = Date.now();
      const isStale = staleAt > 0 && now > staleAt;
      // Recency comes from our explicit revalidating-at stamp, not CF's `Age`
      // header (see CACHE_REVALIDATING_AT_HEADER). An absent/zero stamp counts
      // as "not recent" so a dropped revalidation re-arms instead of pinning.
      const isRevalidating =
        status === "REVALIDATING" &&
        revalidatingAt > 0 &&
        now - revalidatingAt < MAX_REVALIDATION_INTERVAL * 1000;

      // Single emitter for the post-header L1 outcomes. Undefined (so the event
      // object is never allocated) when debug is off; the informational-only
      // `age` header is read lazily inside for the same reason.
      const debugRead = this.debug
        ? (
            outcome: CFCacheReadDebugEvent["outcome"],
            bodyReadMs: number,
            shouldRevalidate?: boolean,
          ) =>
            this.emitDebug({
              op: "get",
              key,
              outcome,
              status: response.status,
              cacheStatus: status,
              staleAt,
              revalidatingAt,
              ageHeader: response.headers.get("age"),
              isStale,
              isRevalidating,
              shouldRevalidate,
              matchMs,
              markerMs,
              bodyReadMs,
            })
        : undefined;

      // Case 1: Fresh or already being revalidated - just return data
      if (!isStale || isRevalidating) {
        const bodyStart = Date.now();
        const {
          value: data,
          errored,
          error,
        } = await this.readJsonWithTimeout<CachedEntryData>(response);
        const bodyReadMs = Date.now() - bodyStart;
        if (data === undefined) {
          debugRead?.(errored ? "body-error" : "body-timeout", bodyReadMs);
          // A body-ERROR (corrupt/foreign body) self-heals via healCorruptL1:
          // report cache-corrupt, fall through to L2/KV (which overwrites the
          // bad entry), and evict only if KV had no good copy to promote. A
          // body-TIMEOUT is a degraded read of a likely-valid entry: leave it
          // intact and suppress revalidation so a stalling colo cannot herd.
          if (errored)
            return this.healCorruptL1(cache, request, error, "get", () =>
              this.kvGetSegment(key, { suppressRevalidate: false }),
            );
          return this.kvGetSegment(key, { suppressRevalidate: true });
        }
        debugRead?.(
          isRevalidating ? "l1-revalidating-guarded" : "l1-fresh",
          bodyReadMs,
          false,
        );
        return { data, shouldRevalidate: false };
      }

      // Case 2: Stale and needs revalidation.
      // Read the body under the edge-read budget BEFORE writing the REVALIDATING
      // marker. CF can resolve match() fast but stall the body stream; the prior
      // approach teed the stream and awaited cache.put(b1) first, which blocked
      // on that same stalled stream so the read budget could never fire on a
      // stale hit. Reading first bounds the stall and lets us skip marking an
      // entry we could not even read.
      const bodyStart = Date.now();
      const {
        value: data,
        errored,
        error,
      } = await this.readJsonWithTimeout<CachedEntryData>(response);
      const bodyReadMs = Date.now() - bodyStart;
      if (data === undefined) {
        debugRead?.(errored ? "body-error" : "body-timeout", bodyReadMs);
        // Heal + conditionally evict a body-error, suppress a body-timeout; see
        // Case 1.
        if (errored)
          return this.healCorruptL1(
            cache,
            request,
            error,
            "get(revalidating)",
            () => this.kvGetSegment(key, { suppressRevalidate: false }),
          );
        return this.kvGetSegment(key, { suppressRevalidate: true });
      }

      // Mark REVALIDATING so concurrent requests don't all revalidate, then
      // return the stale data. The marker write is non-blocking and best-effort
      // (see markRevalidating) -- it must not add latency to, or fail, the served
      // stale read.
      this.markRevalidating(
        cache,
        request,
        response.headers,
        response.status,
        JSON.stringify(data),
      );

      debugRead?.("l1-stale-revalidate", bodyReadMs, true);
      return { data, shouldRevalidate: true };
    } catch (error) {
      // reportCacheError logs and routes to onError (cache-read); the debug
      // emit is the separate wrangler-tail signal. Keep both observability paths.
      reportCacheError(error, "cache-read", "[CFCacheStore] get");
      if (this.debug) this.emitDebug({ op: "get", key, outcome: "error" });
      return null;
    }
  }

  /**
   * Store entry data with TTL and optional SWR window.
   * Uses waitUntil for non-blocking write when available.
   * When KV is configured, also persists to L2.
   */
  async set(
    key: string,
    data: CachedEntryData,
    ttl: number,
    swr?: number,
  ): Promise<void> {
    if (this.isReservedSegmentKey(key, "cache-write")) return;
    try {
      const cache = await this.getCache();
      const request = this.keyToRequest(key);

      // Extended TTL covers SWR window
      const swrWindow = resolveSwrWindow(swr, this.defaults);
      const totalTtl = ttl + swrWindow;
      const staleAt = Date.now() + ttl * 1000;

      // Stamp the tag timestamp at write time and carry it (with the tags)
      // into both the L1 body and the KV envelope so reads can run the
      // invalidation check.
      const taggedAt =
        Array.isArray(data.tags) && data.tags.length > 0
          ? Date.now()
          : undefined;
      const dataToStore: CachedEntryData = taggedAt
        ? { ...data, taggedAt }
        : data;

      const body = JSON.stringify(dataToStore);
      const response = new Response(body, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=${totalTtl}`,
          [CACHE_STALE_AT_HEADER]: String(staleAt),
          // Absolute hard-expiry deadline so a stale-path re-put can recompute a
          // shrinking max-age instead of restarting retention (see
          // remainingCacheControl / CACHE_EXPIRES_AT_HEADER).
          [CACHE_EXPIRES_AT_HEADER]: String(staleAt + swrWindow * 1000),
          [CACHE_STATUS_HEADER]: "HIT",
          ...this.tagHeaderEntries(dataToStore.tags, taggedAt),
        },
      });

      const putPromise = cache.put(request, response);

      if (this.waitUntil) {
        // Non-blocking write. These store-level background tasks intentionally
        // omit the reportingAsync ctx argument: the store is a request-agnostic
        // singleton and this.waitUntil is the execution context's, not a single
        // request's, so a failure is reported console-loud only (it cannot be
        // attributed to one request's onError). The request-scoped tag verbs
        // (revalidateTag / stale-revalidation) DO thread their captured ctx.
        this.waitUntil(() =>
          reportingAsync(
            () => putPromise,
            "cache-write",
            "[CFCacheStore] L1 write",
          ),
        );
      } else {
        // Blocking fallback
        await putPromise;
      }

      // L2: persist to KV
      this.kvSetSegment(key, dataToStore, staleAt, totalTtl, swrWindow);
    } catch (error) {
      reportCacheError(error, "cache-write", "[CFCacheStore] set");
    }
  }

  /**
   * Delete a cached entry from L1 and L2.
   */
  async delete(key: string): Promise<boolean> {
    if (this.isReservedSegmentKey(key, "cache-delete")) return false;
    try {
      const cache = await this.getCache();
      const result = await cache.delete(this.keyToRequest(key));

      // L2: delete from KV
      if (this.kv && this.waitUntil) {
        const kvKey = this.toKVKey(key);
        this.waitUntil(() =>
          reportingAsync(
            () => this.kv!.delete(kvKey),
            "cache-delete",
            "[CFCacheStore] delete L2",
          ),
        );
      }

      return result;
    } catch (error) {
      reportCacheError(error, "cache-delete", "[CFCacheStore] delete");
      return false;
    }
  }

  // ============================================================================
  // Document Cache Methods
  // ============================================================================

  /**
   * Get a cached Response by key (for document-level caching).
   * Returns the response and whether it should be revalidated (SWR).
   * Falls back to KV (L2) on L1 miss.
   */
  async getResponse(
    key: string,
  ): Promise<{ response: Response; shouldRevalidate: boolean } | null> {
    try {
      const cache = await this.getCache();
      const request = this.keyToRequest(`doc:${key}`);
      // The document path is outside the debug surface (op is only get/getItem),
      // so the match-timeout flag is not surfaced as an event here -- though
      // matchWithTimeout still warns on a slow match. A miss or timeout falls
      // through to the KV document path and then render.
      const { response, error: matchError } = await this.matchWithTimeout(
        cache,
        request,
      );

      if (!response || response.status !== 200) {
        // A transient L1 match rejection (matchError set; only ever set when
        // response is undefined) is surfaced as cache-read before degrading to
        // L2/KV -- matching get()/getItem(). A genuine miss or a non-200 hit
        // carries no matchError and reports nothing.
        if (matchError)
          reportCacheError(
            matchError,
            "cache-read",
            "[CFCacheStore] getResponse L1 match",
          );
        return this.kvGetResponse(key);
      }

      // Tag invalidation check (treat invalidated entry as a miss).
      const tagInfo = this.readTagInfo(response.headers);
      if (await this.isGloballyInvalidated(tagInfo.tags, tagInfo.taggedAt)) {
        return null;
      }

      // Check staleness
      const staleAt = Number(response.headers.get(CACHE_STALE_AT_HEADER) || 0);
      const isStale = staleAt > 0 && Date.now() > staleAt;

      // L1 document bodies are streamed through verbatim - unlike the segment/
      // item tiers (which JSON-parse and so structurally detect corruption) and
      // the KV doc tier (validated in kvGetResponse, KV being the real partial-
      // read vector). Integrity here relies on the Cache API: cache.put stores a
      // response atomically or fails, so a truncated body is not served back. We
      // deliberately do NOT buffer+hash the body to re-verify it: that would
      // defeat streaming the document and add a full read to every cache hit.
      return {
        response: this.toClientResponse(response),
        shouldRevalidate: isStale,
      };
    } catch (error) {
      reportCacheError(error, "cache-read", "[CFCacheStore] getResponse");
      return null;
    }
  }

  /**
   * Strip internal edge headers and restore the author's Cache-Control before a
   * cached document Response is served to a client. L1 entries carry the
   * internal staleness/status headers and a rewritten Cache-Control; none of
   * those should reach the browser or an upstream CDN.
   */
  private toClientResponse(response: Response): Response {
    const headers = new Headers(response.headers);
    const originalCacheControl = headers.get(CACHE_ORIG_CC_HEADER);
    if (originalCacheControl !== null) {
      headers.set("Cache-Control", originalCacheControl);
    } else {
      headers.delete("Cache-Control");
    }
    headers.delete(CACHE_ORIG_CC_HEADER);
    headers.delete(CACHE_STALE_AT_HEADER);
    headers.delete(CACHE_STATUS_HEADER);
    headers.delete(CACHE_TAGS_HEADER);
    headers.delete(CACHE_TAGGED_AT_HEADER);
    // Finding #3 (read side): strip per-client signals a pre-fix or
    // pinned-version L1 entry may carry. See the read-side note in the design doc.
    stripPerClientSignals(headers);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  /**
   * Store a Response with TTL and optional SWR window (for document-level caching).
   * When KV is configured, also persists to L2.
   */
  async putResponse(
    key: string,
    response: Response,
    ttl: number,
    swr?: number,
    tags?: string[],
  ): Promise<void> {
    try {
      const cache = await this.getCache();
      const request = this.keyToRequest(`doc:${key}`);

      // Extended TTL covers SWR window
      const swrWindow = resolveSwrWindow(swr, this.defaults);
      const totalTtl = ttl + swrWindow;
      const staleAt = Date.now() + ttl * 1000;
      const taggedAt =
        Array.isArray(tags) && tags.length > 0 ? Date.now() : undefined;

      // Clone body for potential KV write before consuming it for L1
      const [l1Body, kvBody] = this.kv
        ? response.body
          ? response.body.tee()
          : [null, null]
        : [response.body, null];

      // Clone and add cache headers. The author's Cache-Control is stashed and
      // replaced with a long max-age so the CF Cache API holds the entry across
      // the SWR window; getResponse restores the original before serving.
      const headers = new Headers(response.headers);
      // Finding #3: never persist a per-client signal in the shared L1 entry
      // (the platform's Set-Cookie rejection is unverified and ignores the
      // directive anyway). See stripPerClientSignals.
      stripPerClientSignals(headers);
      const originalCacheControl = response.headers.get("Cache-Control");
      if (originalCacheControl !== null) {
        headers.set(CACHE_ORIG_CC_HEADER, originalCacheControl);
      }
      headers.set("Cache-Control", `public, max-age=${totalTtl}`);
      headers.set(CACHE_STALE_AT_HEADER, String(staleAt));
      // Internal tag headers (stripped by toClientResponse before serving).
      const tagHeaders = this.tagHeaderEntries(tags, taggedAt);
      for (const [name, value] of Object.entries(tagHeaders)) {
        headers.set(name, value);
      }

      const toCache = new Response(l1Body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });

      const putPromise = cache.put(request, toCache);

      if (this.waitUntil) {
        // Non-blocking write
        this.waitUntil(() =>
          reportingAsync(
            () => putPromise,
            "cache-write",
            "[CFCacheStore] L1 write",
          ),
        );
      } else {
        // Blocking fallback
        await putPromise;
      }

      // L2: persist to KV (KV requires expirationTtl >= 60s)
      if (this.kv && this.waitUntil && totalTtl >= 60) {
        const kvKey = this.toKVKey(`doc:${key}`);
        // Finding #3: never persist a per-client signal in the KV envelope.
        const headersArray: [string, string][] = [];
        response.headers.forEach((v, k) => {
          if (isPerClientSignalHeader(k)) return;
          headersArray.push([k, v]);
        });
        // Read body as ArrayBuffer and encode to base64 to preserve binary payloads
        const bodyBuf = kvBody
          ? await new Response(kvBody).arrayBuffer()
          : new ArrayBuffer(0);
        const bodyBase64 = bufferToBase64(bodyBuf);

        this.waitUntil(() =>
          reportingAsync(
            () => {
              const envelope: KVResponseEnvelope = {
                b: bodyBase64,
                st: response.status,
                stx: response.statusText,
                hd: headersArray,
                s: staleAt,
                e: staleAt + swrWindow * 1000,
                t: tags,
                ta: taggedAt,
              };
              return this.kv!.put(kvKey, JSON.stringify(envelope), {
                expirationTtl: totalTtl,
              });
            },
            "cache-write",
            "[CFCacheStore] kvPutResponse",
          ),
        );
      }
    } catch (error) {
      reportCacheError(error, "cache-write", "[CFCacheStore] putResponse");
    }
  }

  // ============================================================================
  // Function Cache Methods (for "use cache" directive)
  // ============================================================================

  /**
   * Get a cached function result by key.
   * Follows the same SWR pattern as get() for segment caching.
   * Falls back to KV (L2) on L1 miss.
   */
  async getItem(key: string): Promise<CacheItemResult | null> {
    try {
      const cache = await this.getCache();
      const request = this.keyToRequest(`fn:${key}`);
      const matchStart = Date.now();
      const {
        response,
        timedOut,
        error: matchError,
      } = await this.matchWithTimeout(cache, request);
      const matchMs = Date.now() - matchStart;

      if (!response) {
        // Transient match error reported cache-read; still degrades to L2/KV.
        if (matchError)
          reportCacheError(
            matchError,
            "cache-read",
            "[CFCacheStore] getItem L1 match",
          );
        if (this.debug)
          this.emitDebug({
            op: "getItem",
            key,
            // match-error (rejection) vs l1-miss (absence); see get().
            outcome: matchError
              ? "match-error"
              : timedOut
                ? "match-timeout"
                : "l1-miss",
            matchMs,
          });
        return this.kvGetItem(key);
      }

      // Non-200 entry is not a valid cached function result; treat as a miss.
      if (response.status !== 200) {
        if (this.debug)
          this.emitDebug({
            op: "getItem",
            key,
            outcome: "non-200",
            status: response.status,
            matchMs,
          });
        // Degraded fall-through: suppress revalidation so a broken L1 entry hit
        // concurrently serves KV-stale instead of spawning a herd (see get()).
        return this.kvGetItem(key, { suppressRevalidate: true });
      }

      // Tag invalidation check (treat invalidated entry as a miss). Measure the
      // marker-resolution tail only under debug (see get()).
      const tagInfo = this.readTagInfo(response.headers);
      const markerStart = this.debug ? Date.now() : 0;
      const invalidated = await this.isGloballyInvalidated(
        tagInfo.tags,
        tagInfo.taggedAt,
      );
      const markerMs = this.debug ? Date.now() - markerStart : undefined;
      if (invalidated) {
        if (this.debug)
          this.emitDebug({
            op: "getItem",
            key,
            outcome: "tag-invalidated",
            status: response.status,
            matchMs,
            markerMs,
          });
        return null;
      }

      const staleAt = Number(
        response.headers.get(CACHE_STALE_AT_HEADER) ?? "0",
      );
      const status = response.headers.get(CACHE_STATUS_HEADER);
      const revalidatingAt = Number(
        response.headers.get(CACHE_REVALIDATING_AT_HEADER) ?? "0",
      );

      const now = Date.now();
      const isStale = staleAt > 0 && now > staleAt;
      // Recency from our explicit stamp, not CF's `Age` header (see get()).
      const isRevalidating =
        status === "REVALIDATING" &&
        revalidatingAt > 0 &&
        now - revalidatingAt < MAX_REVALIDATION_INTERVAL * 1000;

      // Single emitter for the post-header L1 outcomes (see get()). Undefined
      // when debug is off, so the event object is never allocated on the hot
      // path; the informational-only `age` header is read lazily inside.
      const debugRead = this.debug
        ? (
            outcome: CFCacheReadDebugEvent["outcome"],
            bodyReadMs: number,
            shouldRevalidate?: boolean,
          ) =>
            this.emitDebug({
              op: "getItem",
              key,
              outcome,
              status: response.status,
              cacheStatus: status,
              staleAt,
              revalidatingAt,
              ageHeader: response.headers.get("age"),
              isStale,
              isRevalidating,
              shouldRevalidate,
              matchMs,
              markerMs,
              bodyReadMs,
            })
        : undefined;

      const bodyStart = Date.now();
      const {
        value: data,
        errored,
        error,
      } = await this.readJsonWithTimeout<{
        value: string;
        handles?: string;
      }>(response);
      const bodyReadMs = Date.now() - bodyStart;
      if (data === undefined) {
        debugRead?.(errored ? "body-error" : "body-timeout", bodyReadMs);
        // Heal + conditionally evict a body-error, suppress a body-timeout; see
        // get().
        if (errored)
          return this.healCorruptL1(cache, request, error, "getItem", () =>
            this.kvGetItem(key, { suppressRevalidate: false }),
          );
        return this.kvGetItem(key, { suppressRevalidate: true });
      }

      if (!isStale || isRevalidating) {
        debugRead?.(
          isRevalidating ? "l1-revalidating-guarded" : "l1-fresh",
          bodyReadMs,
          false,
        );
        return {
          value: data.value,
          handles: data.handles,
          shouldRevalidate: false,
          tags: tagInfo.tags,
        };
      }

      // Stale and needs revalidation -- mark REVALIDATING (non-blocking,
      // best-effort, remaining-ttl) and return the stale value. See get() /
      // markRevalidating for the full rationale.
      this.markRevalidating(
        cache,
        request,
        response.headers,
        200,
        JSON.stringify(data),
      );

      debugRead?.("l1-stale-revalidate", bodyReadMs, true);
      return {
        value: data.value,
        handles: data.handles,
        shouldRevalidate: true,
        tags: tagInfo.tags,
      };
    } catch (error) {
      reportCacheError(error, "cache-read", "[CFCacheStore] getItem");
      if (this.debug) this.emitDebug({ op: "getItem", key, outcome: "error" });
      return null;
    }
  }

  /**
   * Store a function result with TTL and optional SWR window.
   * When KV is configured, also persists to L2.
   */
  async setItem(
    key: string,
    value: string,
    options?: CacheItemOptions,
  ): Promise<void> {
    try {
      const cache = await this.getCache();
      const request = this.keyToRequest(`fn:${key}`);

      const ttl = resolveTtl(options?.ttl, this.defaults, DEFAULT_FUNCTION_TTL);
      const swrWindow = resolveSwrWindow(options?.swr, this.defaults);
      const totalTtl = ttl + swrWindow;
      const staleAt = Date.now() + ttl * 1000;

      const tags = options?.tags;
      const taggedAt =
        Array.isArray(tags) && tags.length > 0 ? Date.now() : undefined;

      const body = JSON.stringify({ value, handles: options?.handles });
      const response = new Response(body, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=${totalTtl}`,
          [CACHE_STALE_AT_HEADER]: String(staleAt),
          // Absolute hard-expiry deadline; see set() / remainingCacheControl.
          [CACHE_EXPIRES_AT_HEADER]: String(staleAt + swrWindow * 1000),
          [CACHE_STATUS_HEADER]: "HIT",
          ...this.tagHeaderEntries(tags, taggedAt),
        },
      });

      const putPromise = cache.put(request, response);

      if (this.waitUntil) {
        this.waitUntil(() =>
          reportingAsync(
            () => putPromise,
            "cache-write",
            "[CFCacheStore] L1 write",
          ),
        );
      } else {
        await putPromise;
      }

      // L2: persist to KV (KV requires expirationTtl >= 60s)
      if (this.kv && this.waitUntil && totalTtl >= 60) {
        const kvKey = this.toKVKey(`fn:${key}`);
        this.waitUntil(() =>
          reportingAsync(
            () => {
              const envelope: KVItemEnvelope = {
                v: value,
                h: options?.handles,
                s: staleAt,
                e: staleAt + swrWindow * 1000,
                t: tags,
                ta: taggedAt,
              };
              return this.kv!.put(kvKey, JSON.stringify(envelope), {
                expirationTtl: totalTtl,
              });
            },
            "cache-write",
            "[CFCacheStore] kvSetItem",
          ),
        );
      }
    } catch (error) {
      reportCacheError(error, "cache-write", "[CFCacheStore] setItem");
    }
  }

  // ============================================================================
  // Key Helpers
  // ============================================================================

  /**
   * Convert string key to Request object for CF Cache API.
   * Includes version in URL if specified (for cache invalidation on code changes).
   * @internal
   */
  private keyToRequest(key: string): Request {
    const encodedKey = encodeURIComponent(key);
    // Include version in URL path to invalidate cache when version changes
    const versionPath = this.version ? `v/${this.version}/` : "";
    return new Request(`${this.resolveBaseUrl()}${versionPath}${encodedKey}`, {
      method: "GET",
    });
  }

  /**
   * Convert string key to KV key string.
   * Uses same version prefix as Cache API for consistent invalidation.
   * @internal
   */
  private toKVKey(key: string): string {
    const versionPath = this.version ? `v/${this.version}/` : "";
    return `${versionPath}${key}`;
  }

  /**
   * Best-effort delete of a single KV key, reporting (not swallowing) a delete
   * failure as cache-delete. Used by the corrupt-entry self-heal paths.
   * @internal
   */
  private async evictKvKey(kvKey: string, label: string): Promise<void> {
    try {
      await this.kv!.delete(kvKey);
    } catch (error) {
      reportCacheError(
        error,
        "cache-delete",
        `[CFCacheStore] ${label}: evict failed`,
      );
    }
  }

  /**
   * Schedule a corrupt-entry KV eviction as a NON-BLOCKING background task
   * (waitUntil) instead of awaiting it on the request path. The corrupt read has
   * already resolved to a miss; awaiting an unbounded kv.delete here would re-add
   * exactly the multi-second stall the read budgets exist to prevent when the KV
   * namespace is degraded. evictKvKey never rejects (it reports its own failure),
   * so the fire-and-forget fallback is safe when no waitUntil is available.
   * @internal
   */
  private scheduleKvEvict(kvKey: string, label: string): void {
    const evict = (): Promise<void> => this.evictKvKey(kvKey, label);
    if (this.waitUntil) this.waitUntil(evict);
    else void evict();
  }

  /**
   * KV-get a JSON envelope, EVICTING the key only when it is genuinely corrupt.
   *
   * Reads as { type: "text" }, NOT { type: "json" }, on purpose: the "json" form
   * fuses the network read and the JSON parse, so a transient KV outage (5xx/429/
   * network blip) is indistinguishable from a malformed body and would delete a
   * still-good cross-colo entry - a self-inflicted miss storm. Reading text lets a
   * transient read error propagate to the caller's outer catch (reported
   * cache-read, the entry left intact); only a JSON.parse failure on a body that
   * WAS successfully read - or an envelope that parses but fails `validate`
   * (fields missing from a truncated write) - is true corruption that evicts +
   * reports cache-corrupt. A MISSING key (kv.get -> null) is a normal miss.
   * @internal
   */
  private async kvGetOrEvict<T>(
    kvKey: string,
    validate: (envelope: T) => boolean,
    label: string,
  ): Promise<{ value: T | null; timedOut: boolean }> {
    // Bound the read with the KV latency budget (inherited from #558) so a
    // degraded namespace cannot pin the request. readWithTimeout reports
    // timedOut on budget expiry; a transient read REJECTION (5xx/429/network)
    // instead propagates out to the caller's outer catch (reported cache-read,
    // the entry left intact) -- deliberately NOT caught as corruption.
    const { value: raw, timedOut } = await this.readWithTimeout<unknown>(
      () => this.kv!.get(kvKey, { type: "text" }),
      this.kvReadTimeoutMs,
      "KV read",
    );
    if (timedOut) return { value: null, timedOut: true };
    if (raw == null) return { value: null, timedOut: false }; // missing = miss

    // Real CF KV with { type: "text" } returns a string: parse + structurally
    // validate it; a parse/validate failure on a successfully-read body is the
    // only true corruption (evict + cache-corrupt). A KV binding that already
    // returns a parsed object (some shims/tests) is used as-is.
    let envelope: T;
    if (typeof raw === "string") {
      try {
        envelope = JSON.parse(raw) as T;
      } catch (error) {
        reportCacheError(
          error,
          "cache-corrupt",
          `[CFCacheStore] ${label}: corrupt JSON in KV, evicting`,
        );
        this.scheduleKvEvict(kvKey, label);
        return { value: null, timedOut: false };
      }
    } else {
      envelope = raw as T;
    }

    // A body that parses to null or a primitive ('null', '42', 'true', '"x"')
    // is not a valid envelope. Guard it BEFORE validate(): the property-reading
    // validators throw on a null/primitive rather than returning false, which
    // would escape to the caller's outer catch as a transient cache-read and
    // leave the bad key un-evicted (re-failing every read until its KV TTL). The
    // typeof check short-circuits validate() so it only ever runs on an object.
    if (
      envelope == null ||
      typeof envelope !== "object" ||
      !validate(envelope)
    ) {
      reportCacheError(
        new Error("malformed/partial KV envelope"),
        "cache-corrupt",
        `[CFCacheStore] ${label}: malformed envelope, evicting`,
      );
      this.scheduleKvEvict(kvKey, label);
      return { value: null, timedOut: false };
    }
    return { value: envelope, timedOut: false };
  }

  // ============================================================================
  // Tag Invalidation (single-store: markers live in this.kv)
  // ============================================================================

  /** KV key for a tag's invalidation marker. */
  private tagMarkerKey(tag: string): string {
    return this.toKVKey(`${TAG_MARKER_PREFIX}${tag}`);
  }

  /**
   * Header entries carrying an entry's tags (JSON-encoded, comma-safe) and the
   * timestamp they were attached. Returns an empty object when there are no
   * tags so untagged entries stay header-free and skip the invalidation check.
   */
  private tagHeaderEntries(
    tags: string[] | undefined,
    taggedAt: number | undefined,
  ): Record<string, string> {
    if (!Array.isArray(tags) || tags.length === 0 || !taggedAt) return {};
    return {
      // encodeURIComponent so the value is pure ASCII: HTTP header values are
      // ByteStrings, but JSON.stringify leaves codepoints > U+00FF (emoji/CJK)
      // verbatim, which makes new Response({ headers }) throw and the outer
      // try/catch silently drop the whole entry from cache. Decoded in
      // readTagInfo. The L1 marker Cache-Tag path encodes for the same reason.
      [CACHE_TAGS_HEADER]: encodeURIComponent(JSON.stringify(tags)),
      [CACHE_TAGGED_AT_HEADER]: String(taggedAt),
    };
  }

  /** Read an entry's tags/taggedAt back from its headers. */
  private readTagInfo(headers: Headers): {
    tags?: string[];
    taggedAt?: number;
  } {
    const rawTags = headers.get(CACHE_TAGS_HEADER);
    const rawTaggedAt = headers.get(CACHE_TAGGED_AT_HEADER);
    if (!rawTags || !rawTaggedAt) return {};
    try {
      return {
        tags: JSON.parse(decodeURIComponent(rawTags)) as string[],
        taggedAt: Number(rawTaggedAt),
      };
    } catch {
      return {};
    }
  }

  /**
   * Whether an entry tagged at `taggedAt` with `tags` has been invalidated since.
   * Reads the per-tag invalidation markers from KV and returns true if any tag's
   * latest invalidation is at or after taggedAt (>= so a same-millisecond
   * invalidate wins, favouring freshness over staleness). Fails open: KV errors
   * never turn a hit into a wrongful miss-storm beyond this single read.
   */
  private async isGloballyInvalidated(
    tags: string[] | undefined,
    taggedAt: number | undefined,
  ): Promise<boolean> {
    // Array.isArray (not just truthiness): a non-array tags value - direct store
    // misuse like setItem(k, v, { tags: "products" }), or a skewed KV envelope -
    // must fail safe to "not invalidated" rather than throwing `.map` on every
    // read (which the outer catch would mis-report as a transient cache-read).
    if (!this.kv || !Array.isArray(tags) || tags.length === 0 || !taggedAt)
      return false;
    const ctx = _getRequestContext();
    const memo = ctx ? getTagMarkerMemo(ctx, this) : undefined;
    const inflight = ctx ? getTagMarkerInflight(ctx, this) : undefined;
    try {
      const markers = await Promise.all(
        tags.map((tag) => this.readTagMarker(tag, memo, inflight)),
      );
      for (const marker of markers) {
        if (marker != null && marker >= taggedAt) return true;
      }
      return false;
    } catch (error) {
      reportCacheError(
        error,
        "cache-read",
        "[CFCacheStore] tag invalidation check",
      );
      return false;
    }
  }

  /** Synthetic Cache API request for a tag's L1-cached invalidation marker. */
  private tagMarkerRequest(tag: string): Request {
    return this.keyToRequest(`${TAG_MARKER_CACHE_PREFIX}${tag}`);
  }

  /**
   * Read a tag's latest invalidation timestamp (or null if never invalidated)
   * through the cascade: per-request memo -> per-colo L1 cache (only when
   * tagCacheTtl > 0) -> KV (the global truth). The memo is always consulted
   * first so it stays authoritative within a request (read-your-own-writes),
   * and every KV/L1 result is written back into the memo. A Cache API miss
   * always falls through to KV; absence is represented by a cached sentinel,
   * never by a miss.
   *
   * Concurrent reads of the same tag within a request share one in-flight read
   * (the resolved-value memo only collapses sequential reads; parallel segment
   * loading would otherwise issue one KV read per concurrent reader).
   * @internal
   */
  private async readTagMarker(
    tag: string,
    memo: Map<string, number | null> | undefined,
    inflight: Map<string, Promise<number | null>> | undefined,
  ): Promise<number | null> {
    if (memo && memo.has(tag)) return memo.get(tag) ?? null;

    // Collapse concurrent (not-yet-resolved) reads of this tag onto one promise.
    if (inflight) {
      const pending = inflight.get(tag);
      if (pending) return pending;
      const read = this.fetchTagMarker(tag, memo);
      inflight.set(tag, read);
      try {
        return await read;
      } finally {
        // Resolved values now live in the memo; drop the in-flight entry.
        inflight.delete(tag);
      }
    }

    return this.fetchTagMarker(tag, memo);
  }

  /**
   * Uncached body of readTagMarker: L1 (per-colo Cache API, opt-in via
   * tagCacheTtl) -> KV. Writes the resolved value back into the memo.
   * @internal
   */
  private async fetchTagMarker(
    tag: string,
    memo: Map<string, number | null> | undefined,
  ): Promise<number | null> {
    // Write the resolved marker into the memo WITHOUT clobbering a value a
    // concurrent invalidateTags() wrote during our await. The router resolves
    // sibling slots in parallel, so a slot's updateTag() can land the
    // authoritative invalidatedAt into the memo while this read is still in
    // flight; overwriting it with our (pre-invalidation) read result would break
    // read-your-own-writes for the rest of the request. If the tag was memoized
    // mid-read, that value wins and is returned. Without a memo, the read result
    // stands as-is.
    const memoize = (read: number | null): number | null => {
      if (memo && memo.has(tag)) return memo.get(tag) ?? null;
      memo?.set(tag, read);
      return read;
    };

    // L1 (per-colo) marker cache - opt-in via tagCacheTtl. Bounded by the same
    // edge budgets as data reads (inherited from #558) so a degraded colo cannot
    // stall a tagged read; a miss, timeout, or error all fall through to KV.
    if (this.tagCacheTtl > 0) {
      try {
        const cache = await this.getCache();
        const { response: hit, error: matchError } =
          await this.matchWithTimeout(cache, this.tagMarkerRequest(tag));
        // A transient match REJECTION is captured (not thrown) by
        // matchWithTimeout; surface it as cache-read like the data read paths
        // before falling through to KV, rather than silently dropping it.
        if (matchError)
          reportCacheError(
            matchError,
            "cache-read",
            "[CFCacheStore] tag marker L1 match",
          );
        if (hit) {
          const { value: body } = await this.readWithTimeout(
            () => hit.text(),
            this.edgeReadTimeoutMs,
            "tag marker L1 body read",
          );
          if (body !== undefined) {
            const value = body === TAG_MARKER_ABSENT ? null : Number(body);
            return memoize(value);
          }
        }
      } catch {
        // Fall through to KV on any L1 read error.
      }
    }

    // KV (global truth), bounded by the KV budget. On TIMEOUT fail OPEN: treat
    // the marker as absent (-> entry not invalidated -> served) so a degraded
    // namespace cannot pin every tagged read behind a slow global lookup. A
    // transient REJECTION instead propagates to isGloballyInvalidated's catch
    // (reported cache-read), which also fails open. Either way one slow tag
    // never amplifies into a per-segment stall.
    const { value: raw, timedOut } = await this.readWithTimeout<string | null>(
      () => this.kv!.get(this.tagMarkerKey(tag), { type: "text" }),
      this.kvReadTimeoutMs,
      "tag marker KV read",
    );
    if (timedOut) {
      // Memoize the fail-open result so the rest of this request is consistent
      // (and does not re-pay the timeout per segment sharing the tag).
      return memoize(null);
    }
    const value = raw != null ? Number(raw) : null;
    const resolved = memoize(value);

    // Populate L1 for subsequent reads in this colo (non-blocking). Use the
    // resolved (memo-aware) value so a marker invalidated mid-read is not
    // re-cached stale into this colo's L1.
    if (this.tagCacheTtl > 0) {
      const put = () => this.putTagMarkerL1(tag, resolved);
      if (this.waitUntil) this.waitUntil(put);
      else void put();
    }
    return resolved;
  }

  /**
   * Cloudflare Cache-Tags written on a tag's L1 marker entry, namespaced per
   * store so purges never collide with other Cache-Tags in the zone. Three
   * tiers, broad to specific:
   *   rg:{ns}            - everything this store cached (deploy/nuclear reset)
   *   rg:{ns}:lk         - all tag-lookup markers
   *   rg:{ns}:lk:{tag}   - this tag's lookup (the normal updateTag purge target)
   * The tag value is encodeURIComponent'd so commas/spaces can't corrupt the
   * comma-delimited Cache-Tag header.
   * @internal
   */
  private lookupCacheTags(tag: string): string[] {
    const ns = this.namespace ?? "default";
    return [`rg:${ns}`, `rg:${ns}:lk`, this.lookupPurgeTag(tag)];
  }

  /** The specific Cache-Tag a consumer purges to evict tag `tag`'s lookup. */
  private lookupPurgeTag(tag: string): string {
    const ns = this.namespace ?? "default";
    return `rg:${ns}:lk:${encodeURIComponent(tag)}`;
  }

  /**
   * Write a tag marker value into the per-colo L1 Cache API with tagCacheTtl.
   * `null` is stored as the TAG_MARKER_ABSENT sentinel so "no marker yet" is
   * cacheable (most tags are never invalidated - that is where the read savings
   * come from). The entry also carries a namespaced Cache-Tag so an external
   * purge-by-tag (via onRevalidateTag) can evict it across colos promptly,
   * rather than waiting out tagCacheTtl. Best-effort.
   * @internal
   */
  private async putTagMarkerL1(
    tag: string,
    value: number | null,
    opts?: { critical?: boolean },
  ): Promise<void> {
    if (this.tagCacheTtl <= 0) return;
    try {
      const cache = await this.getCache();
      const body = value != null ? String(value) : TAG_MARKER_ABSENT;
      await cache.put(
        this.tagMarkerRequest(tag),
        new Response(body, {
          headers: {
            "Cache-Control": `public, max-age=${this.tagCacheTtl}`,
            "Cache-Tag": this.lookupCacheTags(tag).join(","),
          },
        }),
      );
    } catch (error) {
      // The read-path populate is best-effort: a failed populate just means the
      // next read consults KV. The invalidation WRITE-THROUGH (critical) is not
      // - silently swallowing it would leave this colo's stale marker (often the
      // ABSENT sentinel) authoritative for tagCacheTtl while updateTag reports
      // success. Surface it, and best-effort delete the L1 marker so the next
      // read re-reads KV, which already holds the fresh marker (written before
      // this write-through in invalidateTags).
      if (opts?.critical) {
        reportCacheError(
          error,
          "cache-invalidate",
          "[CFCacheStore] tag marker L1 write-through",
        );
        await reportingAsync(
          async () => {
            const cache = await this.getCache();
            await cache.delete(this.tagMarkerRequest(tag));
          },
          "cache-delete",
          "[CFCacheStore] tag marker L1 evict after failed write-through",
        );
      }
    }
  }

  /**
   * Invalidate every entry tagged with any of `tags`. Receives the whole batch
   * from one updateTag()/revalidateTag() call so the eager-purge hook fires
   * ONCE (one CDN purge request, not one per tag). For each tag: records the KV
   * marker (the durable cross-colo truth that reads compare taggedAt against),
   * writes the fresh marker straight into this colo's L1 (write-through, NOT
   * delete - a delete would let the next read re-read a not-yet-converged KV
   * value and re-arm the stale window), and memoizes it for same-request
   * read-your-own-writes. Finally fires onRevalidateTag with the namespaced
   * lookup Cache-Tags so a consumer purge evicts the cached lookups in other
   * colos promptly (otherwise they converge within tagCacheTtl).
   *
   * Durable-write integrity: the in-memory write-through (memo + L1) for a tag
   * runs ONLY after that tag's KV marker write is confirmed. If any KV write
   * fails (transient error, or an over-512-byte key), this rejects with the
   * failed tags so an awaiting updateTag() surfaces the failure instead of
   * silently reporting success while other requests/colos serve stale data. The
   * eager purge still fires for the whole batch first (it is additive).
   */
  async invalidateTags(tags: string[]): Promise<void> {
    if (tags.length === 0) return;
    const invalidatedAt = Date.now();
    const ctx = _getRequestContext();
    const memo = ctx ? getTagMarkerMemo(ctx, this) : undefined;

    if (!this.kv && !this.onRevalidateTag) {
      console.warn(
        `[CFCacheStore] invalidateTags had no effect: configure a KV namespace ` +
          `for distributed invalidation, or an onRevalidateTag hook.`,
      );
    }

    const failedTags = new Set<string>();
    const errors: unknown[] = [];
    if (this.kv) {
      await Promise.all(
        tags.map(async (tag) => {
          const markerKey = this.tagMarkerKey(tag);
          if (kvKeyByteLength(markerKey) > KV_MAX_KEY_BYTES) {
            failedTags.add(tag);
            errors.push(
              new Error(
                `tag "${tag}" produces a ${kvKeyByteLength(markerKey)}-byte KV ` +
                  `marker key, over the ${KV_MAX_KEY_BYTES}-byte limit`,
              ),
            );
            return;
          }
          try {
            await this.kv!.put(markerKey, String(invalidatedAt), {
              ...(this.tagInvalidationTtl
                ? { expirationTtl: this.tagInvalidationTtl }
                : {}),
            });
          } catch (error) {
            failedTags.add(tag);
            errors.push(error);
          }
        }),
      );
    }

    // Write-through memo + L1 only for tags with a confirmed durable marker, and
    // only when KV is configured. Markers are read exclusively through
    // isGloballyInvalidated(), which short-circuits to "not invalidated" when
    // !this.kv; writing memo/L1 markers without KV would be dead state no read
    // path ever consults. The onRevalidateTag purge below still fires regardless
    // (it is additive and external to the marker cascade). The memo write is
    // synchronous (read-your-own-writes); the L1 Cache API writes are
    // independent, so fan them out in parallel rather than awaiting each.
    if (this.kv) {
      const l1Writes: Promise<void>[] = [];
      for (const tag of tags) {
        if (failedTags.has(tag)) continue;
        memo?.set(tag, invalidatedAt);
        if (this.tagCacheTtl > 0) {
          l1Writes.push(
            this.putTagMarkerL1(tag, invalidatedAt, { critical: true }),
          );
        }
      }
      if (l1Writes.length > 0) await Promise.all(l1Writes);
    }

    // One batched eager purge of the lookup markers for the whole call. Fired
    // regardless of KV write outcome (it is additive and uses pure string ops).
    if (this.onRevalidateTag) {
      try {
        await this.onRevalidateTag(tags.map((tag) => this.lookupPurgeTag(tag)));
      } catch (error) {
        reportCacheError(
          error,
          "cache-invalidate",
          "[CFCacheStore] onRevalidateTag hook",
        );
      }
    }

    if (failedTags.size > 0) {
      const err = new Error(
        `[CFCacheStore] ${failedTags.size}/${tags.length} tag marker write(s) ` +
          `failed: ${[...failedTags].join(", ")}. Those tags may still serve ` +
          `stale data across requests/colos; retry the invalidation.`,
      );
      (err as Error & { cause?: unknown }).cause = errors[0];
      throw err;
    }
  }

  // ============================================================================
  // KV L2 Helpers
  // ============================================================================

  /**
   * KV fallback for segment cache reads.
   * Returns null if KV is not configured, entry is missing, or expired.
   * Promotes hits to L1 via waitUntil.
   * @internal
   */
  private async kvGetSegment(
    key: string,
    opts?: { suppressRevalidate?: boolean },
  ): Promise<CacheGetResult | null> {
    if (!this.kv) return null;

    try {
      const kvKey = this.toKVKey(key);
      const { value: envelope, timedOut } =
        await this.kvGetOrEvict<KVSegmentEnvelope>(
          kvKey,
          (e) =>
            typeof e.e === "number" && typeof e.s === "number" && e.d != null,
          "kvGetSegment",
        );
      if (timedOut) {
        // Abandoned slow KV read: no envelope, so no promote-to-L1. Distinct
        // from a genuine kv-miss so the degradation is visible on wrangler tail.
        if (this.debug)
          this.emitDebug({ op: "get", key, outcome: "kv-timeout" });
        return null;
      }
      if (!envelope) {
        // Missing key, or a corrupt entry already evicted + reported by
        // kvGetOrEvict. Either way a miss.
        if (this.debug) this.emitDebug({ op: "get", key, outcome: "kv-miss" });
        return null;
      }

      const now = Date.now();

      // Hard-expired — treat as miss
      if (now > envelope.e) {
        if (this.debug) this.emitDebug({ op: "get", key, outcome: "kv-miss" });
        return null;
      }

      // Tag invalidation check (also covers the KV tier, not just L1).
      if (
        await this.isGloballyInvalidated(envelope.d.tags, envelope.d.taggedAt)
      ) {
        if (this.debug)
          this.emitDebug({ op: "get", key, outcome: "tag-invalidated" });
        return null;
      }

      // When this is a degraded L1 fall-through (body-timeout / non-200), the
      // caller asks us to suppress revalidation: KV has no REVALIDATING herd
      // guard, so N concurrent degraded reads would otherwise each spawn a
      // render exactly when the colo is already struggling. We still serve the
      // stale data and still promote to L1; only the revalidation is withheld.
      const stale = now > envelope.s;
      const shouldRevalidate = stale && !opts?.suppressRevalidate;

      // Promote to L1 in background
      this.promoteSegmentToL1(key, envelope);

      if (this.debug)
        this.emitDebug({
          op: "get",
          key,
          outcome: !stale
            ? "kv-fresh"
            : opts?.suppressRevalidate
              ? "kv-stale-suppressed"
              : "kv-stale",
          shouldRevalidate,
        });
      return { data: envelope.d, shouldRevalidate };
    } catch (error) {
      reportCacheError(error, "cache-read", "[CFCacheStore] kvGetSegment");
      if (this.debug) this.emitDebug({ op: "get", key, outcome: "error" });
      return null;
    }
  }

  /**
   * Write segment data to KV.
   * @internal
   */
  private kvSetSegment(
    key: string,
    data: CachedEntryData,
    staleAt: number,
    totalTtl: number,
    swrWindow: number,
  ): void {
    // KV requires expirationTtl >= 60s. Skip write for short-lived entries.
    if (!this.kv || !this.waitUntil || totalTtl < 60) return;

    const kvKey = this.toKVKey(key);
    const expiresAt = staleAt + swrWindow * 1000;

    this.waitUntil(() =>
      reportingAsync(
        () => {
          const envelope: KVSegmentEnvelope = {
            d: data,
            s: staleAt,
            e: expiresAt,
          };
          return this.kv!.put(kvKey, JSON.stringify(envelope), {
            expirationTtl: totalTtl,
          });
        },
        "cache-write",
        "[CFCacheStore] kvSetSegment",
      ),
    );
  }

  /**
   * Promote segment data from KV to L1 Cache API.
   * @internal
   */
  private promoteSegmentToL1(key: string, envelope: KVSegmentEnvelope): void {
    if (!this.waitUntil) return;

    this.waitUntil(() =>
      reportingAsync(
        async () => {
          const now = Date.now();
          const remainingTtl = Math.max(
            1,
            Math.floor((envelope.e - now) / 1000),
          );
          const cache = await this.getCache();
          const request = this.keyToRequest(key);

          const response = new Response(JSON.stringify(envelope.d), {
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": `public, max-age=${remainingTtl}`,
              [CACHE_STALE_AT_HEADER]: String(envelope.s),
              // Carry the hard-expiry deadline so a promoted entry that later
              // goes stale re-puts with the correct remaining ttl (see set()).
              [CACHE_EXPIRES_AT_HEADER]: String(envelope.e),
              [CACHE_STATUS_HEADER]: "HIT",
              // Preserve tags across KV->L1 promotion so the promoted entry
              // stays tag-invalidatable.
              ...this.tagHeaderEntries(envelope.d.tags, envelope.d.taggedAt),
            },
          });

          await cache.put(request, response);
        },
        "cache-write",
        "[CFCacheStore] promoteSegmentToL1",
      ),
    );
  }

  /**
   * KV fallback for function cache reads.
   * @internal
   */
  private async kvGetItem(
    key: string,
    opts?: { suppressRevalidate?: boolean },
  ): Promise<CacheItemResult | null> {
    if (!this.kv) return null;

    try {
      const kvKey = this.toKVKey(`fn:${key}`);
      const { value: envelope, timedOut } =
        await this.kvGetOrEvict<KVItemEnvelope>(
          kvKey,
          (e) =>
            typeof e.v === "string" &&
            typeof e.e === "number" &&
            typeof e.s === "number",
          "kvGetItem",
        );
      if (timedOut) {
        if (this.debug)
          this.emitDebug({ op: "getItem", key, outcome: "kv-timeout" });
        return null;
      }
      if (!envelope) {
        if (this.debug)
          this.emitDebug({ op: "getItem", key, outcome: "kv-miss" });
        return null;
      }

      const now = Date.now();

      if (now > envelope.e) {
        if (this.debug)
          this.emitDebug({ op: "getItem", key, outcome: "kv-miss" });
        return null;
      }

      // Tag invalidation check (also covers the KV tier, not just L1).
      if (await this.isGloballyInvalidated(envelope.t, envelope.ta)) {
        if (this.debug)
          this.emitDebug({ op: "getItem", key, outcome: "tag-invalidated" });
        return null;
      }

      // Degraded fall-through suppresses revalidation (no KV herd guard); see
      // kvGetSegment. Still serves stale and still promotes.
      const stale = now > envelope.s;
      const shouldRevalidate = stale && !opts?.suppressRevalidate;

      // Promote to L1
      this.promoteItemToL1(key, envelope);

      if (this.debug)
        this.emitDebug({
          op: "getItem",
          key,
          outcome: !stale
            ? "kv-fresh"
            : opts?.suppressRevalidate
              ? "kv-stale-suppressed"
              : "kv-stale",
          shouldRevalidate,
        });
      return {
        value: envelope.v,
        handles: envelope.h,
        shouldRevalidate,
        tags: envelope.t,
      };
    } catch (error) {
      reportCacheError(error, "cache-read", "[CFCacheStore] kvGetItem");
      if (this.debug) this.emitDebug({ op: "getItem", key, outcome: "error" });
      return null;
    }
  }

  /**
   * Promote function cache data from KV to L1.
   * @internal
   */
  private promoteItemToL1(key: string, envelope: KVItemEnvelope): void {
    if (!this.waitUntil) return;

    this.waitUntil(() =>
      reportingAsync(
        async () => {
          const now = Date.now();
          const remainingTtl = Math.max(
            1,
            Math.floor((envelope.e - now) / 1000),
          );
          const cache = await this.getCache();
          const request = this.keyToRequest(`fn:${key}`);

          const body = JSON.stringify({
            value: envelope.v,
            handles: envelope.h,
          });
          const response = new Response(body, {
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": `public, max-age=${remainingTtl}`,
              [CACHE_STALE_AT_HEADER]: String(envelope.s),
              // Carry the hard-expiry deadline; see promoteSegmentToL1 / set().
              [CACHE_EXPIRES_AT_HEADER]: String(envelope.e),
              [CACHE_STATUS_HEADER]: "HIT",
              // Preserve tags across KV->L1 promotion (the item tier previously
              // dropped them, permanently disabling tag invalidation here).
              ...this.tagHeaderEntries(envelope.t, envelope.ta),
            },
          });

          await cache.put(request, response);
        },
        "cache-write",
        "[CFCacheStore] promoteItemToL1",
      ),
    );
  }

  /**
   * KV fallback for document cache reads.
   * @internal
   */
  private async kvGetResponse(
    key: string,
  ): Promise<{ response: Response; shouldRevalidate: boolean } | null> {
    if (!this.kv) return null;

    try {
      const kvKey = this.toKVKey(`doc:${key}`);
      // The document path is debug-silent (op is only get/getItem): a KV-read
      // timeout here is bounded for resilience parity (kvGetOrEvict applies the
      // budget) but emits no kv-timeout event, so its absence from the debug
      // stream is expected. A null envelope is a miss -- missing key, a budget
      // timeout, or a corrupt entry already evicted + reported by kvGetOrEvict.
      const { value: envelope } = await this.kvGetOrEvict<KVResponseEnvelope>(
        kvKey,
        (e) =>
          typeof e.b === "string" &&
          typeof e.st === "number" &&
          typeof e.e === "number" &&
          typeof e.s === "number" &&
          Array.isArray(e.hd),
        "kvGetResponse",
      );
      if (!envelope) return null;

      const now = Date.now();

      if (now > envelope.e) return null;

      // Tag invalidation check (also covers the KV tier, not just L1).
      if (await this.isGloballyInvalidated(envelope.t, envelope.ta)) {
        return null;
      }

      const shouldRevalidate = now > envelope.s;

      // Reconstruct Response: decode base64 -> binary, rebuild headers/status.
      // Corrupt/partial base64 throws in atob; malformed `hd` or an out-of-range
      // `st` throws in new Headers/new Response. Any of these is a faulty entry,
      // so evict it and miss rather than re-failing every read until TTL.
      let response: Response;
      try {
        // Finding #3 (read side): strip per-client signals a stale envelope may
        // carry. Inside the try so a malformed `hd` evicts (not throws through);
        // mutates `hd` in place so promoteResponseToL1 re-seeds from it too.
        envelope.hd = envelope.hd.filter(
          ([name]) => !isPerClientSignalHeader(name),
        );
        const bodyBuffer = base64ToBuffer(envelope.b);
        const headers = new Headers(envelope.hd);
        response = new Response(bodyBuffer, {
          status: envelope.st,
          statusText: envelope.stx,
          headers,
        });
      } catch (error) {
        reportCacheError(
          error,
          "cache-corrupt",
          "[CFCacheStore] kvGetResponse: corrupt response envelope, evicting",
        );
        this.scheduleKvEvict(kvKey, "kvGetResponse");
        return null;
      }

      // Promote to L1
      this.promoteResponseToL1(key, envelope);

      return { response, shouldRevalidate };
    } catch (error) {
      reportCacheError(error, "cache-read", "[CFCacheStore] kvGetResponse");
      return null;
    }
  }

  /**
   * Promote document cache data from KV to L1.
   * @internal
   */
  private promoteResponseToL1(key: string, envelope: KVResponseEnvelope): void {
    if (!this.waitUntil) return;

    this.waitUntil(() =>
      reportingAsync(
        async () => {
          const now = Date.now();
          const remainingTtl = Math.max(
            1,
            Math.floor((envelope.e - now) / 1000),
          );
          const cache = await this.getCache();
          const request = this.keyToRequest(`doc:${key}`);

          const headers = new Headers(envelope.hd);
          const originalCacheControl = headers.get("Cache-Control");
          if (originalCacheControl !== null) {
            headers.set(CACHE_ORIG_CC_HEADER, originalCacheControl);
          }
          headers.set("Cache-Control", `public, max-age=${remainingTtl}`);
          headers.set(CACHE_STALE_AT_HEADER, String(envelope.s));
          // Re-attach the internal tag headers (envelope.hd is client-facing
          // and intentionally excludes them) so the promoted entry stays
          // invalidatable.
          const tagHeaders = this.tagHeaderEntries(envelope.t, envelope.ta);
          for (const [name, value] of Object.entries(tagHeaders)) {
            headers.set(name, value);
          }

          const bodyBuffer = base64ToBuffer(envelope.b);
          const response = new Response(bodyBuffer, {
            status: envelope.st,
            statusText: envelope.stx,
            headers,
          });

          await cache.put(request, response);
        },
        "cache-write",
        "[CFCacheStore] promoteResponseToL1",
      ),
    );
  }
}

// ============================================================================
// Base64 Helpers (binary-safe response body encoding for KV)
// ============================================================================

/** Encode ArrayBuffer to base64 string. */
function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/** Decode base64 string to ArrayBuffer. */
function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
