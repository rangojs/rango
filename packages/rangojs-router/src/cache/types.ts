/**
 * Cache Store Types
 *
 * Generic caching interface supporting multiple value types.
 * Designed to be implemented by different backends:
 * - MemoryCacheStore (dev/testing)
 * - Cloudflare Cache API adapter
 * - Cloudflare KV adapter
 * - Redis adapter
 */

import type { ResolvedSegment } from "../types.js";
import type { RequestContext } from "../server/request-context.js";

/**
 * Sentinel a `SegmentCacheStore.get` MAY return instead of `null` when the
 * read FAILED (backend error) rather than genuinely missing. For the render
 * outcome the two are identical — render fresh, re-cache — so hit/miss-only
 * consumers can treat it as a miss. The PPR replay composition needs the
 * distinction: an errored explicit-tier read must render uncached
 * (`lookupRouteDetailed` classifies it `error`), never be substituted by the
 * seeded doc record — the built-in stores swallow backend errors internally,
 * so without this signal their failures read as replayable misses. Third-party
 * stores returning plain `null` on error keep the miss classification.
 */
export const CACHE_READ_ERROR: unique symbol = Symbol.for(
  "rango.cache.readError",
);
export type CacheReadError = typeof CACHE_READ_ERROR;

/**
 * Result from cache get() including data and revalidation status
 */
export interface CacheGetResult {
  /** The cached entry data */
  data: CachedEntryData;
  /**
   * Whether the caller should trigger background revalidation.
   * True when entry is stale AND not already being revalidated.
   * The store atomically marks the entry as REVALIDATING when returning true.
   */
  shouldRevalidate: boolean;
}

/**
 * Low-level segment cache store interface.
 *
 * Implementations handle the actual storage (memory, KV, Redis, etc.).
 * The store deals with serialized data - RSC serialization is handled
 * by the cache provider layer.
 *
 * @typeParam TEnv - Platform bindings type (e.g., Cloudflare env)
 */
export interface SegmentCacheStore<TEnv = unknown> {
  /**
   * The store honors getShell(..., { claimRevalidation: false }) without
   * claiming an SWR lock. Navigation replay requires this opt-in because it
   * cannot recapture an HTML shell after observing a stale entry.
   */
  readonly supportsPassiveShellReads?: true;

  /**
   * Default cache options for this store.
   * Used by cache() boundaries when ttl/swr are not explicitly specified.
   */
  readonly defaults?: CacheDefaults;

  /**
   * Custom key generator applied to all cache operations using this store.
   * Receives the full RequestContext and the default-generated key.
   * Return value becomes the final cache key (unless route overrides with `key` option).
   *
   * Resolution priority:
   * 1. Route-level `key` function (full override)
   * 2. Store-level `keyGenerator` (modifies default key)
   * 3. Default key generation (prefix:pathname:params)
   *
   * @example Using headers for cache segmentation
   * ```typescript
   * keyGenerator: (ctx, defaultKey) => {
   *   const segment = ctx.request.headers.get('x-user-segment') || 'default';
   *   return `${segment}:${defaultKey}`;
   * }
   * ```
   *
   * @example Using env bindings (Cloudflare)
   * ```typescript
   * keyGenerator: (ctx, defaultKey) => {
   *   const region = ctx.env.REGION || 'us';
   *   return `${region}:${defaultKey}`;
   * }
   * ```
   *
   * @example Using cookies for locale
   * ```typescript
   * keyGenerator: (ctx, defaultKey) => {
   *   const locale = cookies().get('locale')?.value || 'en';
   *   return `${locale}:${defaultKey}`;
   * }
   * ```
   */
  readonly keyGenerator?: (
    ctx: RequestContext<TEnv>,
    defaultKey: string,
  ) => string | Promise<string>;

  /**
   * Get cached entry data by key
   * @returns Cache result with data and staleness, null if not found/expired,
   * or CACHE_READ_ERROR when the read failed (optional — see the sentinel).
   */
  get(key: string): Promise<CacheGetResult | null | CacheReadError>;

  /**
   * Store entry data with TTL
   * @param key - Cache key
   * @param data - Serialized entry data
   * @param ttl - Time-to-live in seconds
   * @param swr - Optional stale-while-revalidate window in seconds
   */
  set(
    key: string,
    data: CachedEntryData,
    ttl: number,
    swr?: number,
  ): Promise<void>;

  /**
   * Delete a cached entry
   * @returns true if deleted, false if not found
   */
  delete(key: string): Promise<boolean>;

  /**
   * Clear all cached entries (optional, for testing)
   */
  clear?(): Promise<void>;

  /**
   * Get a cached Response by key.
   * Returns the response and whether it should be revalidated (SWR).
   */
  getResponse?(
    key: string,
  ): Promise<{ response: Response; shouldRevalidate: boolean } | null>;

  /**
   * Store a Response with TTL and optional SWR window.
   * @param key - Cache key
   * @param response - Response to cache (will be cloned)
   * @param ttl - Time-to-live in seconds
   * @param swr - Optional stale-while-revalidate window in seconds
   * @param tags - Optional cache tags for invalidation
   */
  putResponse?(
    key: string,
    response: Response,
    ttl: number,
    swr?: number,
    tags?: string[],
  ): Promise<void>;

  /**
   * Get a cached PPR shell entry by key.
   * Returns the stored prelude/postponed pair (see ShellCacheEntry) and whether
   * it should be revalidated (SWR). Used by the shell-cache middleware to serve
   * a cached HTML shell and resume fizz for just the live holes.
   *
   * Optional: a store that does not implement the shell family disables the
   * shell-cache middleware (it fails open to the normal HTML render path).
   * A passive read reports a stale entry as `shouldRevalidate: true` without
   * claiming store-specific revalidation ownership.
   */
  getShell?(
    key: string,
    options?: { claimRevalidation?: boolean },
  ): Promise<{ entry: ShellCacheEntry; shouldRevalidate?: boolean } | null>;

  /**
   * Store a PPR shell entry with TTL and optional SWR window.
   * The prelude bytes and postponed state are version- and generation-coupled
   * and travel together in a single entry (they must never mix across a React
   * upgrade — the reactVersion field on the entry gates that at read time).
   * @param key - Cache key
   * @param entry - The shell prelude/postponed/version/createdAt bundle
   * @param ttlSeconds - Time-to-live in seconds
   * @param swrSeconds - Optional stale-while-revalidate window in seconds
   * @param tags - Optional cache tags for invalidation (participates in
   *   invalidateTags via the same tag machinery as the item family)
   * @returns `invalidated` when a generation marker rejected the write,
   *   `stored` when acknowledged, or void for stores without acknowledgements.
   */
  putShell?(
    key: string,
    entry: ShellCacheEntry,
    ttlSeconds?: number,
    swrSeconds?: number,
    tags?: string[],
  ): Promise<"stored" | "invalidated" | void>;

  /**
   * Declares the shell family present-but-inert: getShell/putShell exist but
   * no-op (CFCacheStore without a KV namespace). scheduleShellCapture skips
   * captures whose only write target is inert — the background render would be
   * dead work that still occupies the per-isolate serialized capture queue
   * (a promise-heavy route bakes for seconds per MISS with nothing stored).
   * Absent/false means the family, when present, actually stores.
   */
  shellFamilyInert?: boolean;

  /**
   * Get a cached function result by key.
   * Returns the serialized value, optional handle data, and staleness flag.
   */
  getItem?(key: string): Promise<CacheItemResult | null>;

  /**
   * Store a function result with TTL and optional SWR window.
   * @param key - Cache key (format: use-cache:{functionId}:{serializedArgs})
   * @param value - RSC-serialized return value
   * @param options - TTL, SWR, handle data, and tags
   */
  setItem?(
    key: string,
    value: string,
    options?: CacheItemOptions,
  ): Promise<void>;

  /**
   * Invalidate every cache entry (segment, response, item) tagged with any of
   * `tags`. Store-level primitive that the public updateTag()/revalidateTag()
   * APIs delegate to. Receives ALL of one invalidation call's tags at once so
   * stores can batch their work (e.g. a single CDN purge request rather than
   * one per tag). Stores that do not support tags simply omit this method.
   * @param tags - The cache tags to invalidate
   */
  invalidateTags?(tags: string[]): Promise<void>;

  /**
   * True when ANY of `tags` was invalidated (invalidateTags/updateTag) at or
   * after `sinceMs` (>= so a same-millisecond invalidation wins, favouring
   * freshness). Consulted by build-shell read-through and runtime shell stores:
   * "was it evicted" is answered by tag markers against the entry's createdAt,
   * including when invalidation races a capture that has not been written yet.
   * Optional: without it, TAGGED build entries are not served (untagged ones
   * are unaffected — they are evictable only by deploy/buildVersion anyway).
   * Fail open to `false` on marker-read errors: a transient store fault must
   * degrade to "still valid", the same posture as the envelope tag checks.
   */
  isTagsInvalidatedSince?(tags: string[], sinceMs: number): Promise<boolean>;
}

/**
 * Result from getItem() for function-level caching ("use cache").
 */
export interface CacheItemResult {
  /** RSC-serialized return value */
  value: string;
  /** RSC-encoded handle data captured during execution (breadcrumbs, metadata,
   *  etc.). Encoded via the Flight codec so Promise/ReactNode handle values
   *  survive JSON-serializing stores — see handle-snapshot.ts encodeHandles. */
  handles?: string;
  /** Whether the entry is stale and should be revalidated */
  shouldRevalidate: boolean;
  /**
   * The entry's cache tags (including runtime cacheTag() tags), surfaced on read
   * so a "use cache" HIT can still contribute its tags to the request-scoped tag
   * set used by document-level caching. On a hit the cached function is not
   * re-run, so its runtime tags are only available here, not from re-execution.
   */
  tags?: string[];
}

/**
 * A cached PPR (Partial Pre-rendering) shell entry.
 *
 * One entry carries BOTH artifacts a resume needs — the rendered HTML prelude
 * and React's postponed state — because the pair is version- and
 * generation-coupled and must never be mixed across a React upgrade or a build
 * change. The reactVersion and buildVersion fields are the read-time gates that
 * enforce both halves: isValidShellHit (rsc/shell-serve.ts) treats an entry
 * whose reactVersion differs from the running React, or whose buildVersion
 * differs from the running build, as a miss (the postponed blob encodes hole
 * positions against one exact tree; resuming it against a different React or a
 * different app build tree-mismatches inside resume(), AFTER the 200 + prelude
 * are committed — an unrecoverable broken serve).
 */
export interface ShellCacheEntry {
  /** Rendered HTML prelude bytes, base64-encoded (stores are JSON-serializing). */
  prelude: string;
  /**
   * JSON.stringify of React's postponed state, or null when the shell settled
   * with no holes (the DATA variant — served without a fizz resume).
   */
  postponed: string | null;
  /** React.version captured at prerender time; the read-time invalidation gate. */
  reactVersion: string;
  /**
   * Build version captured at prerender time (the RSC handler's `version` —
   * the `@rangojs/router:version` build stamp by default, bumped per build and
   * on dev RSC-module edits). The second read-time gate: a persistent shared
   * store (KV/runtime-cache) survives deploys, and an app-code change that
   * keeps the same React version would otherwise leave a stale-build
   * prelude+postponed live under the same key. Optional only for entries
   * stored before the field existed — those are treated as a miss and the
   * recapture re-stamps them (pre-release, no compat shim).
   */
  buildVersion?: string;
  /**
   * The initialTheme the CAPTURE render was built with (the derived context's
   * reqCtx.theme). The resume tail must render ThemeProvider with the SAME
   * initialTheme the frozen prelude was rendered with: React resume requires the
   * tree above the holes to match the prerendered tree, and initialTheme is
   * per-request METADATA, not part of the cached segments — a visitor whose
   * theme differs from the capturer's would otherwise produce a divergent resume
   * tree (broken stitching/hydration). The visitor's real theme is applied
   * pre-paint by the FOUC script and re-synced from the cookie post-mount by
   * ThemeProvider.
   */
  initialTheme?: string;
  /**
   * The CAPTURE DATA SNAPSHOT: every cache-store read-hit and write the capture
   * render performed, in stored/serialized form. Replaying these on a HIT (via
   * the SeededShellStore overlay, for the tail render only) reproduces the
   * shell's cached content byte-identically, so the freshly rendered hydration
   * payload matches the frozen prelude even after the underlying cache entries
   * have drifted (expired, been recomputed, or been tag-invalidated).
   *
   * Optional: an entry captured before this field existed simply has no
   * snapshot and keeps the pre-snapshot behavior (the tail reads live, so any
   * shell-baked cached value that drifted mismatches the prelude). Recapture
   * heals it. See docs/design/ppr-shell-resume.md ("the capture data snapshot").
   */
  snapshot?: ShellSnapshotRecord[];
  /**
   * The key of the CANONICAL document segment record inside `snapshot` — the
   * one navigation replay can actually consume (resolved under the implicit
   * doc namespace at capture; see CacheScope.cacheRoute). Replay eligibility
   * requires this exact record: the snapshot also carries incidentally
   * recorded explicit-tier records (RecordingShellStore passthroughs) whose
   * keys a partial lookup can never resolve, and counting those declared
   * entries "replayable" that always missed (`snapshot-miss` flip-flop).
   * Absent on entries captured before the field existed OR when the capture
   * recorded no doc record (cache(false)/condition-false routes, prerender
   * short-circuit) — both read as `no-segment-snapshot`; recapture heals the
   * former.
   */
  docKey?: string;
  /**
   * The entry was captured from a partial request only to produce an eligible
   * segment snapshot. Document serving must treat its HTML prelude as a miss;
   * the partial request's headers and middleware state are not document state.
   */
  navigationOnly?: true;
  /**
   * True when the capture's HANDLER layer declared per-request liveness: a
   * handle pushed OUTSIDE a DSL loader scope carried a nested thenable (the
   * capture mask turns it into a never-filling hole), such a push was still
   * pending when the entry was written, or a handler-invoked loader
   * (ctx.use(loader) from a handler body — the consumption lane, #672)
   * executed during the capture. The serve tail then must NOT take the
   * handler-free fast path (the implicit doc-cache hit): only a handler
   * re-run can mint that hole's live promise or refresh that consumed value.
   * DSL-loader pushes never set this — loaders re-run fresh on every HIT, so
   * their holes always fill.
   */
  handlerLiveHoles?: boolean;
  /**
   * Legacy/fallback marker for a transition({ when }) predicate that was not
   * evaluated by the PPR pre-handler gate. Such an entry stays conservatively
   * ineligible for handler-free replay. New PPR matches evaluate known segment
   * predicates before the pipeline and do not set this marker.
   */
  transitionWhen?: true;
  /** Capture-generation start time; tag invalidations at or after it win. */
  createdAt: number;
}

/**
 * The families a shell snapshot pins. The item/segment/response families are
 * cache-store reads/writes (recorded by RecordingShellStore); the loader family
 * pins the settled CONTAINER of a bake-lane loader (a loader on an entry with
 * no renderable loading(), executed during capture — see
 * docs/design/loader-container-bake.md). Excludes the shell family itself
 * (getShell/putShell) — the snapshot rides INSIDE a shell entry, so recording
 * it would be self-referential.
 */
export type ShellSnapshotFamily = "item" | "segment" | "response" | "loader";

/**
 * The stored form of a loader-family snapshot value: the bake-lane loader's
 * settled container, Flight-serialized AFTER eliding every still-pending nested
 * promise to a hole marker (the marker paths are holes, not shell material; on
 * a HIT the overlay re-slots the fresh run's promises there). Flight (not JSON)
 * so typed values (Date/Map) survive the round trip.
 */
export interface ShellSnapshotLoaderValue {
  /** RSC-serialized elided container (see loader-snapshot.ts). */
  value: string;
  /**
   * Hole bit, capture-computed (elide already walks every node): 1 = the
   * container carries hole markers, so a HIT must gate the overlay on the
   * fresh run (only the loader body can mint the live nested promises);
   * 0 = fully pinned, so a HIT resolves the payload promise immediately from
   * the pin while the fresh run proceeds ungated (side effects and cache
   * read-through writes preserved; its values were discarded either way —
   * recorded paths win wholesale). Absent on pre-bit snapshots, which keep
   * the gated path.
   */
  holes?: 0 | 1;
}

/** A serialized cached Response for the response family of a shell snapshot. */
export interface ShellSnapshotResponseValue {
  status: number;
  /** Client-facing header pairs (per-client signal headers excluded at record). */
  headers: [string, string][];
  /** base64-encoded response body (binary-safe, JSON-serializable). */
  body: string;
}

/** The stored form of an item-family (use cache / loader cache) snapshot value. */
export interface ShellSnapshotItemValue {
  /** RSC-serialized return value. */
  value: string;
  /** RSC-encoded handle data, if any. */
  handles?: string;
  /** The entry's cache tags. */
  tags?: string[];
}

/**
 * One recorded cache-store read-hit or write from the capture render. `value`
 * carries the entry in its stored/serialized shape so it round-trips through a
 * JSON-serializing store (KV, CF, Vercel) with the rest of the ShellCacheEntry:
 * - `item`    -> {@link ShellSnapshotItemValue}
 * - `segment` -> {@link CachedEntryData} (already JSON-able)
 * - `response`-> {@link ShellSnapshotResponseValue}
 */
export interface ShellSnapshotRecord {
  family: ShellSnapshotFamily;
  key: string;
  value:
    | ShellSnapshotItemValue
    | CachedEntryData
    | ShellSnapshotResponseValue
    | ShellSnapshotLoaderValue;
}

/**
 * Options for setItem() for function-level caching ("use cache").
 */
export interface CacheItemOptions {
  /** RSC-encoded handle data to store alongside the value (see encodeHandles). */
  handles?: string;
  /** Time-to-live in seconds */
  ttl?: number;
  /** Stale-while-revalidate window in seconds */
  swr?: number;
  /** Cache tags for invalidation */
  tags?: string[];
}

/**
 * Serialized segment data stored in cache
 * Note: loading is preserved to ensure consistent tree structure between cached and fresh renders
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export interface SerializedSegmentData {
  /** RSC-encoded component string */
  encoded: string;
  /** RSC-encoded layout string (if present) */
  encodedLayout?: string;
  /** RSC-encoded loading skeleton string (if present), or "null" for explicit null */
  encodedLoading?: string;
  /** RSC-encoded loaderData (if present) */
  encodedLoaderData?: string;
  /** RSC-encoded loaderDataPromise (if present) */
  encodedLoaderDataPromise?: string;
  /** Segment metadata (everything except component, layout, loading, and loader data) */
  metadata: Omit<
    ResolvedSegment,
    "component" | "layout" | "loading" | "loaderData" | "loaderDataPromise"
  >;
}

/**
 * Raw data stored in cache for an entry
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export interface CachedEntryData {
  /** Serialized segments for this entry */
  segments: SerializedSegmentData[];
  /** RSC-encoded handle data keyed by segment ID. Encoded via the Flight codec
   *  (see handle-snapshot.ts encodeHandles) so Promise/ReactNode handle values
   *  round-trip through JSON-serializing stores instead of being flattened. */
  handles: string;
  /** Expiration timestamp (ms since epoch) */
  expiresAt: number;
  /** Cache tags for invalidation */
  tags?: string[];
  /** Timestamp (ms since epoch) when tags were attached, for distributed invalidation */
  taggedAt?: number;
}

/**
 * Default cache options applied to all cache() boundaries.
 * Individual cache() calls can override any of these values.
 *
 * @example
 * ```ts
 * const store = new CFCacheStore({
 *   defaults: { ttl: 60, swr: 300 }
 * });
 * ```
 */
export interface CacheDefaults {
  /**
   * Default time-to-live in seconds.
   * After TTL expires, cached entry is considered stale.
   * Must be a finite, non-negative number; an invalid value (NaN/Infinity/
   * negative) falls back to the default at read time.
   */
  ttl?: number;
  /**
   * Default stale-while-revalidate window in seconds.
   * During SWR window, stale content is served while revalidating in background.
   * Must be a finite, non-negative number; an invalid value (NaN/Infinity/
   * negative) falls back to the default at read time.
   */
  swr?: number;
}

/**
 * Handle data for a single segment
 * Structure: { handleName: [values...] }
 */
export type SegmentHandleData = Record<string, unknown[]>;
