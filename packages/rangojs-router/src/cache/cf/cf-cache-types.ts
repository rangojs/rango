// ============================================================================
// Types
// ============================================================================
//
// Shared public types for the CF cache store: the minimal KVNamespace shape, the
// debug-event surface, and the store options. Extracted from cf-cache-store.ts
// so they can be referenced without importing the class; re-exported from
// cf-cache-store.ts so existing import paths still resolve. The private KV
// envelope interfaces stay in cf-cache-store.ts with the methods that use them.

// Imported from the canonical home (also publicly exported from src/index.ts /
// src/index.rsc.ts) so this module shares the one interface rather than
// declaring a second that could drift.
import type { ExecutionContext } from "../../types/request-scope.js";
import type { CacheDefaults, CacheFreshness } from "../types.js";
import type { RequestContext } from "../../server/request-context.js";
import type { CloudflareZonePurgeOptions } from "./cf-zone-purge.js";

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
  freshness?: CacheFreshness;
  revalidationClaimed?: boolean;
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
   * Purge-based tag invalidation (purge mode). When configured, the store
   * delegates L1 (Cache API) tag eviction to Cloudflare's purge-by-tag API
   * instead of the per-read KV marker lookup.
   *
   * Two forms:
   * - **Credentials object** (the normal wiring): `{ zoneId, apiToken }` — the
   *   store builds the purge client itself (createCloudflareZonePurge).
   *   `zoneId` is on the zone's dashboard overview; `apiToken` needs the
   *   `Zone.Cache Purge` permission for that zone — store it as a Worker
   *   secret. Validated at store construction (Workers run no code at deploy,
   *   so with the usual per-request cache factory this means the first request
   *   throws — loudly and on every request), rather than surfacing only when
   *   the first invalidation quietly rejects much later.
   * - **Function** `(cacheTags) => Promise<void>` — an escape hatch for
   *   proxies, custom transports, or test stubs; receives the exact
   *   Cache-Tags to purge.
   *
   * Semantics:
   * - Every tagged L1 entry carries a namespaced `Cache-Tag` header
   *   (`rg:{namespace}:e:{encodedTag}`, plus the broader `rg:{namespace}` /
   *   `rg:{namespace}:e` tiers for manual resets).
   * - `updateTag()`/`revalidateTag()` AWAIT the purge with the exact Cache-Tags
   *   (one batched call per invalidation; entry tags, plus the lookup
   *   Cache-Tags when `tagCacheTtl > 0`).
   * - L1 hits then skip the per-read marker lookup entirely: a surviving entry
   *   is trusted because an invalidated one would have been purged. Only the
   *   per-request memo is consulted (synchronously, no KV read), so a request
   *   that ran `updateTag()` still masks its own not-yet-purged entries
   *   (read-your-own-writes).
   * - The KV tier and PPR shell reads still use the KV markers. Runtime shell
   *   L1 entries are purgeable, but their taggedAt is the capture-start time: a
   *   capture can finish after an invalidation purge, so eviction alone cannot
   *   reject that older generation. Keep `kv` configured for shell L2 + markers.
   *   Without `kv`, purge mode is the ONLY tag invalidation and the store is
   *   L1-only: a supported configuration (previously tag invalidation without
   *   KV had no read-side effect at all). One KV-less caveat: an entry whose
   *   tag set overflows Cloudflare's 16 KB Cache-Tag header limit is NOT
   *   cached (it would be un-invalidatable — no tokens for the purge, no
   *   marker fallback); with `kv` such an entry caches and falls back to the
   *   marker check.
   *
   * Consistency trade-off vs the default marker mode: invalidation latency for
   * concurrent requests becomes the purge propagation time (Cloudflare quotes
   * sub-second "Instant Purge") instead of read-time KV consistency, and a
   * purge failure leaves L1 stale until TTL — which is why a rejected hook
   * makes `updateTag()` reject (retry the invalidation; markers and purge are
   * both idempotent).
   *
   * Zone scoping: purge-by-tag clears YOUR zone. workers.dev / pages.dev
   * previews have an inert Cache API (nothing to purge — the KV tier still
   * invalidates via markers there); a preview on a SEPARATE zone needs its own
   * purge credentials.
   *
   * @example
   * ```ts
   * new CFCacheStore({
   *   ctx,
   *   kv: env.CACHE_KV,
   *   tagPurge: { zoneId: env.CF_ZONE_ID, apiToken: env.CF_PURGE_TOKEN },
   * })
   * ```
   */
  tagPurge?:
    | CloudflareZonePurgeOptions
    | ((cacheTags: string[]) => Promise<void>);

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
