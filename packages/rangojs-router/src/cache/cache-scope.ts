/**
 * CacheScope - Runtime cache scope for iterator-based caching
 *
 * Each cache() boundary in the route tree creates a new CacheScope.
 * The scope owns: config, key management, and storage operations.
 *
 * Serialization is delegated to segment-codec.ts.
 * Handle data capture/restore is delegated to handle-snapshot.ts.
 */

import type { PartialCacheOptions } from "../types.js";
import type { ResolvedSegment } from "../types.js";
import type { SegmentCacheStore, CachedEntryData } from "./types.js";
import { CACHE_READ_ERROR } from "./types.js";
import { INTERNAL_RANGO_DEBUG } from "../internal-debug.js";
import {
  getRequestContext,
  _getRequestContext,
} from "../server/request-context.js";
import {
  getSegmentTags,
  recordRequestTags,
  recordSegmentTags,
  runInSegmentTagScope,
} from "./cache-tag.js";
import { reportCacheError } from "./cache-error.js";
// segment-codec is the only module on cache-scope's import graph that eagerly
// pulls @vitejs/plugin-rsc (a virtual: module the plain node/vitest runner cannot
// resolve). It is imported LAZILY at the two call sites below (deserializeSegments
// in lookupRoute, serializeSegments in cacheRoute) so that requiring cache-scope —
// e.g. dispatch's lazy `import("../cache/cache-scope.js")` for the response-route
// cache path — does not crash a consumer test that never mocks plugin-rsc. Behavior
// is unchanged: both methods are async and already awaited the codec.
import {
  captureHandles,
  captureHandleOwners,
  restoreHandles,
  encodeHandles,
  decodeHandles,
} from "./handle-snapshot.js";
import { cacheKeyBase } from "./cache-key-utils.js";
import {
  DEFAULT_ROUTE_TTL,
  isFiniteNonNegativeSeconds,
  resolveCacheKey,
  resolveCacheStore,
  resolveTagsOption,
} from "./cache-policy.js";
import type { RequestContext } from "../server/request-context.js";

export function resolveCacheTags(
  config: PartialCacheOptions | false,
  ctx: RequestContext | undefined,
): string[] | undefined {
  if (config === false) return undefined;
  return resolveTagsOption(config.tags, ctx, "CacheScope");
}

/**
 * Narrow the request's route-record window (RequestContext._routeRecordWindow)
 * to a record this request read or wrote: fresh until `freshUntil` (the
 * record's `expiresAt`), then stale for `swr` seconds. A shell capture starts
 * with no window of its own (shell-capture.ts deriveShellCaptureContext sets
 * it undefined), so it narrows only to the records the capture itself read
 * or wrote.
 */
function noteRouteRecordWindow(
  requestCtx: RequestContext,
  freshUntil: number,
  ttl: number,
  swr: number,
  written: boolean,
): void {
  const next = {
    freshUntil,
    staleUntil: freshUntil + swr * 1000,
    ttl,
    swr,
    written,
  };
  const current = requestCtx._routeRecordWindow;
  // The record that runs out first names the config; freshness is the least.
  requestCtx._routeRecordWindow = current
    ? {
        ...(current.staleUntil <= next.staleUntil ? current : next),
        freshUntil: Math.min(current.freshUntil, freshUntil),
      }
    : next;
}

function debugCacheLog(message: string): void {
  if (INTERNAL_RANGO_DEBUG) {
    console.log(message);
  }
}

/**
 * A finite, non-negative seconds value? A NaN/Infinity ttl/swr (from a bad
 * cache() option or store defaults) flows into computeExpiration ->
 * staleAt/expiresAt = NaN, where every `now > NaN` is false so the entry never
 * evicts and is served fresh forever; a negative value makes every read a miss.
 * Mirror profile-registry.ts's Number.isFinite + >= 0 check, but the callers
 * degrade to a default (warning in dev) rather than throw — this runs on the
 * foreground render.
 */
function isValidCacheSeconds(value: number, label: string): boolean {
  if (isFiniteNonNegativeSeconds(value)) return true;
  if (process.env.NODE_ENV !== "production") {
    console.warn(
      `[CacheScope] Invalid ${label} ${value}; falling back to default`,
    );
  }
  return false;
}

/** Coerce a resolved ttl to a finite, non-negative number (default on invalid). */
function validatedTtl(value: number): number {
  return isValidCacheSeconds(value, "ttl") ? value : DEFAULT_ROUTE_TTL;
}

/** Coerce a resolved swr to a finite, non-negative number, or undefined (no SWR window). */
function validatedSwr(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return isValidCacheSeconds(value, "swr") ? value : undefined;
}

function getDefaultRouteCacheKey(
  pathname: string,
  params?: Record<string, string>,
  isIntercept?: boolean,
  prefixOverride?: "doc",
): string {
  const ctx = getRequestContext();
  const isPartial = ctx?.originalUrl?.searchParams.has("_rsc_partial") ?? false;
  const searchParams = ctx?.url.searchParams;
  const host = ctx?.url.host ?? "localhost";

  // Intercept navigations get their own cache namespace
  const prefix = isIntercept
    ? "intercept"
    : (prefixOverride ?? (isPartial ? "partial" : "doc"));

  return `${prefix}:${cacheKeyBase(host, pathname, searchParams, params, ctx?._searchParamsFilter)}`;
}

// ============================================================================
// CacheScope
// ============================================================================

const CACHE_HIT_OBSERVERS = new WeakMap<
  CacheScope,
  () => void | Promise<void>
>();

/**
 * Discriminated outcome of a route cache lookup — see
 * {@link CacheScope.lookupRouteDetailed} for what each status licenses.
 */
export type CacheRouteLookupOutcome =
  | {
      status: "hit";
      result: { segments: ResolvedSegment[]; shouldRevalidate: boolean };
    }
  | { status: "miss" | "bypass" | "error" };

/**
 * CacheScope represents a cache boundary in the route tree.
 *
 * When withCache encounters an entry with cache config, it creates
 * a new CacheScope. The scope owns key management, TTL resolution,
 * and storage operations. Serialization is handled by segment-codec.ts.
 *
 * Store resolution priority:
 * 1. Explicit store in cache() options
 * 2. App-level store from handler config
 *
 * TTL resolution priority:
 * 1. Explicit value in cache() options
 * 2. Explicit store's defaults (if store specified)
 * 3. App-level store's defaults
 * 4. Hardcoded fallback (60 seconds)
 */
export class CacheScope {
  readonly config: PartialCacheOptions | false;
  readonly parent: CacheScope | null;
  /** Explicit store from cache() options, if specified */
  private readonly explicitStore: SegmentCacheStore | undefined;

  constructor(
    config: PartialCacheOptions | false,
    parent: CacheScope | null = null,
    private readonly defaultKeyPrefix?: "doc",
    /**
     * @internal shortCode of the outermost cache() entry of this scope's
     * enabled chain (createCacheScope). Entries above it are live: their
     * segments are not stored and resolve fresh on a hit (withCacheLookup).
     * Undefined covers the whole matched chain (the implicit shell doc scope,
     * a ppr route).
     */
    readonly boundary?: string,
  ) {
    this.config = config;
    this.parent = parent;
    // Extract and store explicit store reference
    this.explicitStore = config !== false ? config.store : undefined;
  }

  /**
   * @internal Whether a segment belongs to this scope's cache entry. ShortCodes are
   * hierarchical (server/context.ts getShortCode: parent shortCode + include
   * scope + type letter + counter), so the boundary's subtree is every id that
   * extends the boundary shortCode at a non-digit (`C1` must not claim `C10`).
   * Intercept slot segments ride the target route's entry wherever the
   * intercept is declared.
   */
  covers(id: string, namespace?: string): boolean {
    const boundary = this.boundary;
    if (boundary === undefined) return true;
    if (id.startsWith(boundary)) {
      const next = id.charCodeAt(boundary.length);
      return !(next >= 48 && next <= 57);
    }
    return namespace?.startsWith("intercept:") === true;
  }

  /**
   * Whether caching is enabled for this scope
   */
  get enabled(): boolean {
    return this.config !== false;
  }

  /**
   * Get effective TTL from config or store defaults.
   *
   * Unlike profile-registry.ts (which fails fast at config time), the render
   * path must DEGRADE: a non-finite/negative ttl (NaN/Infinity from a bad
   * defaults config) would make computeExpiration produce NaN deadlines so the
   * entry never evicts, or a guaranteed miss for a negative value. Fall back to
   * DEFAULT_ROUTE_TTL instead of throwing in the foreground render.
   */
  get ttl(): number {
    if (this.config === false) return 0;

    // Explicit TTL in cache() options
    if (this.config.ttl !== undefined) {
      return validatedTtl(this.config.ttl);
    }

    // Fall back to store defaults (explicit store first, then app-level)
    const store = this.getStore();
    if (store?.defaults?.ttl !== undefined) {
      return validatedTtl(store.defaults.ttl);
    }

    // Hardcoded fallback
    return DEFAULT_ROUTE_TTL;
  }

  /**
   * Get SWR window from config or store defaults.
   *
   * A non-finite/negative swr is degraded to undefined (no SWR window) rather
   * than fed into expiry math; see the ttl getter for the rationale.
   */
  get swr(): number | undefined {
    if (this.config === false) return undefined;

    // Explicit SWR in cache() options
    if (this.config.swr !== undefined) {
      return validatedSwr(this.config.swr);
    }

    // Fall back to store defaults
    const store = this.getStore();
    return validatedSwr(store?.defaults?.swr);
  }

  /**
   * Get the cache store - resolution priority:
   * 1. Explicit store from cache() options
   * 2. App-level store from request context
   */
  getStore(): SegmentCacheStore | null {
    return resolveCacheStore(this.explicitStore);
  }

  /**
   * Resolve the cache key using the shared 3-tier priority.
   * @internal
   */
  private resolveKey(
    pathname: string,
    params: Record<string, string>,
    isIntercept?: boolean,
  ): Promise<string> {
    return this.resolveKeyFrom(
      getDefaultRouteCacheKey(
        pathname,
        params,
        isIntercept,
        this.defaultKeyPrefix,
      ),
    );
  }

  /**
   * A shell captured from a route record this request read or wrote must not
   * outlive it (noteRouteRecordWindow). The implicit doc scope's own record
   * is the shell's, so it notes nothing.
   */
  private noteRecordWindow(
    requestCtx: RequestContext,
    freshUntil: number,
    written: boolean,
  ): void {
    if (!this.isShellImplicitDocScope) {
      noteRouteRecordWindow(
        requestCtx,
        freshUntil,
        this.ttl,
        this.swr ?? 0,
        written,
      );
    }
  }

  /**
   * @internal This scope's record key for `defaultKey` (its `key()`, else its
   * store's keyGenerator, else `defaultKey`: resolveCacheKey), resolved once
   * per request: a ppr route's shell partition (resolveShellPartition) and
   * the record lookup share the one call, and a rejection is shared too.
   *
   * The results live on the request context (`_resolvedCacheKeys`), so a
   * shell capture, whose context is `Object.create` of the request's
   * (shell-capture.ts), reads the foreground's through the prototype chain
   * and never runs `key()` itself: a `key()` calling `cookies()` would trip
   * the capture guard there, and a capture must store the partition its
   * request resolved. A `key()` is a full override that never sees
   * `defaultKey`, so it runs once per request whatever the default key
   * (document, partial or `doc` shell prefix); a keyGenerator runs once per
   * default key.
   */
  resolveKeyFrom(defaultKey: string): Promise<string> {
    const keyFn = this.config !== false ? this.config.key : undefined;
    const store = this.getStore();
    const requestCtx = _getRequestContext();
    const by = keyFn ?? store?.keyGenerator;
    if (!requestCtx || !by) {
      return resolveCacheKey(keyFn, store, defaultKey, "CacheScope");
    }
    const memo = (requestCtx._resolvedCacheKeys ??= new Map());
    let resolved = memo.get(by);
    if (!resolved) memo.set(by, (resolved = new Map()));
    const slot = keyFn ? "" : defaultKey;
    let key = resolved.get(slot);
    if (!key) {
      key = resolveCacheKey(keyFn, store, defaultKey, "CacheScope");
      resolved.set(slot, key);
    }
    return key;
  }

  /**
   * @internal Whether a cache read/write is allowed for the current request:
   * the scope is enabled AND its `condition` (if any) returns true. "read"
   * is consulted by the PPR navigation-replay gate BEFORE any shell-store
   * read so a cache(false)/condition-false route reports `cache-disabled`
   * without spending getShell I/O; "write" gates the capture's snapshot-only
   * doc record (cache-store middleware) under the same semantics as the
   * scope's own store write. Consumer opt-outs are absolute — the seeded
   * fallback must never serve where the consumer refused cached serves.
   */
  allowsCache(op: "read" | "write"): boolean {
    return this.enabled && this.conditionAllows(op);
  }

  /**
   * @internal True for scopes minted from the `_shellImplicitCache` marker
   * (createShellImplicitDocScope) — the only construction path that passes
   * the `doc` defaultKeyPrefix; route-derived scopes (createCacheScope) never
   * do. withCacheLookup/withCacheStore use this to tell the implicit doc
   * scope from a route-derived scope: the two compose on the replay serve
   * path and only the route-derived kind gets the seeded fallback /
   * doc-record treatment.
   */
  get isShellImplicitDocScope(): boolean {
    return this.defaultKeyPrefix === "doc";
  }

  /**
   * Evaluate the cache `condition` predicate. Returns false (skip the cache
   * operation) when the predicate returns false or throws; returns true when
   * there is no condition or no request context to evaluate it against.
   */
  /**
   * One WRITE decision per (scope, request), memoized on the request context.
   * A capture render has TWO writers consulting the same predicate — the
   * explicit tier's cacheRoute and the snapshot-only doc record gate
   * (recordShellCaptureDocRecord) — and a true→false flap between the two
   * evaluations recorded a REPLAYABLE canonical snapshot for a render whose
   * real write was refused. The first evaluation pins the answer for the
   * whole render (the capture's derived context during captures). READ
   * decisions stay per-lookup by design: pre-deciding a flappable predicate
   * at the replay gate was the round-2 regression.
   */
  private readonly writeConditionMemo = new WeakMap<RequestContext, boolean>();

  private conditionAllows(op: "read" | "write"): boolean {
    if (this.config === false || !this.config.condition) return true;
    const requestCtx = getRequestContext();
    if (!requestCtx) return true;
    if (op === "write") {
      const memoized = this.writeConditionMemo.get(requestCtx);
      if (memoized !== undefined) return memoized;
    }
    let allowed: boolean;
    try {
      allowed = !!this.config.condition(requestCtx);
      if (!allowed) {
        debugCacheLog(
          `[CacheScope] condition returned false, skipping cache ${op}`,
        );
      }
    } catch (error) {
      console.error(
        `[CacheScope] condition function threw, skipping cache ${op}:`,
        error,
      );
      allowed = false;
    }
    if (op === "write") this.writeConditionMemo.set(requestCtx, allowed);
    return allowed;
  }

  /**
   * Lookup cached segments for a route (single cache entry per request).
   * Returns { segments, shouldRevalidate } or null if cache miss.
   *
   * @param pathname - URL pathname for cache key generation
   * @param params - Route params for cache key generation
   * @param isIntercept - Whether this is an intercept navigation (uses different cache key)
   * @param claimLoaderPushes - The handler context's _claimLoaderPushes, for
   *   restoreHandles' loader-owned values
   */
  async lookupRoute(
    pathname: string,
    params: Record<string, string>,
    isIntercept?: boolean,
    claimLoaderPushes?: (loaderId: string) => boolean,
  ): Promise<{
    segments: ResolvedSegment[];
    shouldRevalidate: boolean;
  } | null> {
    const outcome = await this.lookupRouteDetailed(
      pathname,
      params,
      isIntercept,
      claimLoaderPushes,
    );
    return outcome.status === "hit" ? outcome.result : null;
  }

  /**
   * @internal lookupRoute with a discriminated outcome. The PPR replay
   * composition (withCacheLookup) may substitute the seeded doc record ONLY on
   * a true `miss` — the other non-hit outcomes must not be papered over:
   *
   * - `bypass`: the scope refused the read — cache(false), a false
   *   `condition()`, or no resolvable store. Consumer opt-outs are absolute;
   *   a fallback here would serve cached segments to a request the consumer
   *   said must render fresh.
   * - `error`: a throwing consumer key()/store keyGenerator/store.get. The
   *   contract on that failure is "render uncached" (see the catch below) —
   *   falling back would serve the canonical doc record across a broken key
   *   partition, exactly the collision resolveCacheKey's no-default-fallback
   *   rule exists to prevent.
   *
   * A corrupt entry that was evicted reads as `miss`: the store was consulted
   * and holds nothing servable, which is the post-eviction truth.
   */
  async lookupRouteDetailed(
    pathname: string,
    params: Record<string, string>,
    isIntercept?: boolean,
    claimLoaderPushes?: (loaderId: string) => boolean,
  ): Promise<CacheRouteLookupOutcome> {
    if (!this.enabled) return { status: "bypass" };
    if (!this.conditionAllows("read")) return { status: "bypass" };

    const store = this.getStore();
    if (!store) return { status: "bypass" };

    // Resolve cache key INSIDE the try so a throwing consumer key() (or a
    // store.keyGenerator) degrades to a cache miss (return null -> render
    // uncached) instead of crashing the foreground render. resolveCacheKey
    // itself keeps its hard-fail/no-fallback-to-default contract (a throw must
    // not silently collide onto the default slot); the graceful degradation
    // happens here, where a miss is a safe outcome.
    let key: string | undefined;
    try {
      key = await this.resolveKey(pathname, params, isIntercept);

      const result = await store.get(key);

      // Built-in stores swallow backend read failures internally and signal
      // them with CACHE_READ_ERROR — classify as `error`, not `miss`, so the
      // replay composition renders uncached instead of substituting the
      // seeded doc record for a tier whose backend never answered.
      if (result === CACHE_READ_ERROR) {
        return { status: "error" };
      }

      if (!result) {
        debugCacheLog(`[CacheScope] MISS: ${key}`);
        return { status: "miss" };
      }

      const { data: cached, shouldRevalidate } = result;

      // Deserialize segments. A failure means the cached segments are corrupt/
      // partial: evict the entry (self-heal - the re-render re-caches under the
      // same key) and report it as corruption, distinct from a transient infra
      // error (handled by the outer catch).
      //
      // Shell-HIT tail (_shellFragmentPayload, issue #700): skip the decode and
      // carry the stored fragment strings verbatim — the payload consumers
      // expand them (segment-fragments.ts). Read off the ambient context at the
      // same point the cache key was resolved (getDefaultRouteCacheKey), so the
      // flag shares fate with the key: a disrupted ALS already missed the
      // seeded record, which a document tail turns into the degrade
      // (ShellRecordUnavailableError).
      let segments: ResolvedSegment[];
      const ambientContext = _getRequestContext();
      try {
        const codec = await import("./segment-codec.js");
        segments = ambientContext?._shellFragmentPayload
          ? await codec.fragmentSegments(cached.segments)
          : await codec.deserializeSegments(cached.segments);
      } catch (error) {
        reportCacheError(
          error,
          "cache-corrupt",
          `[CacheScope] ${key}: corrupt cached segments, evicting`,
        );
        await store
          .delete(key)
          .catch((e) =>
            reportCacheError(e, "cache-delete", `[CacheScope] ${key}: evict`),
          );
        if (this.isShellImplicitDocScope) {
          ambientContext?._shellImplicitCache?.onCorrupt?.();
        }
        return { status: "miss" };
      }

      // A record from a whole-chain writer (a previous build on an unversioned
      // store) can hold segments above the boundary. withCacheLookup resolves
      // those fresh, so replaying them too would duplicate them and their
      // handle pushes.
      if (this.boundary !== undefined) {
        segments = segments.filter((s) => this.covers(s.id, s.namespace));
      }

      // A hit serves content that was tagged at write time, so the document
      // tag union must include this entry's tags for updateTag()/revalidateTag()
      // to invalidate any full-page entry built on top of it. The write path
      // records via cacheRoute (resolveCacheTags); the hit path records here,
      // onto the replayed segments too, for a record written from this replay
      // (a shell capture's doc record).
      recordRequestTags(cached.tags);
      recordSegmentTags(
        segments.map((s) => s.id),
        cached.tags,
      );

      // Replay handle data. An empty string means the route pushed no handles —
      // skip the decode entirely (the common case). Otherwise decode the
      // Flight-encoded blob; a decode failure skips handle restore but keeps the
      // valid cached segments.
      const handleStore = _getRequestContext()?._handleStore;
      if (handleStore && cached.handles) {
        const handlesRecord = await decodeHandles(cached.handles);
        if (handlesRecord) {
          if (this.boundary !== undefined) {
            const kept = new Set(segments.map((s) => s.id));
            for (const id of Object.keys(handlesRecord)) {
              if (!kept.has(id)) delete handlesRecord[id];
            }
          }
          restoreHandles(
            handlesRecord,
            handleStore,
            cached.handleOwners,
            claimLoaderPushes,
          );
        }
      }

      if (INTERNAL_RANGO_DEBUG) {
        const segmentTypes = segments.map((s) =>
          s.type === "parallel" ? s.slot : s.type,
        );
        debugCacheLog(
          `[CacheScope] ${shouldRevalidate ? "STALE" : "HIT"}: ${key} (${segmentTypes.join(", ")})`,
        );
      }

      if (ambientContext)
        this.noteRecordWindow(ambientContext, cached.expiresAt, false);

      await CACHE_HIT_OBSERVERS.get(this)?.();
      return { status: "hit", result: { segments, shouldRevalidate } };
    } catch (error) {
      // Covers a store.get() failure AND a throwing consumer key()/keyGenerator
      // (resolveKey). Either way degrade to an uncached render — reported as
      // `error`, not `miss`, so the replay composition cannot substitute the
      // seeded doc record for a lookup that never resolved its key partition.
      reportCacheError(
        error,
        "cache-read",
        `[CacheScope] lookup ${key ?? "(key resolution failed)"}`,
      );
      return { status: "error" };
    }
  }

  /**
   * Record this scope's segment-DSL cache({ tags }) into the request tag union
   * synchronously, under the same gate cacheRoute() uses for a write.
   *
   * cacheRoute() already records these tags, but it is invoked inside
   * requestCtx.waitUntil() by the cache-store middleware (and the proactive path
   * re-resolves the whole tree before calling it), so its recording is deferred
   * and RACES the document cache's post-body-drain snapshot of _requestTags. On a
   * first-write (segment-cache miss) the document tag union could miss these
   * tags, and updateTag()/revalidateTag() would then fail to invalidate the
   * cached document until a later write reseeded it. Calling this synchronously
   * in the request pipeline (before the snapshot) closes that window. Idempotent
   * (the tag union is a Set), so the duplicate record in cacheRoute is harmless.
   */
  recordTags(requestCtx: RequestContext | undefined): void {
    if (!this.enabled) return;
    if (!this.conditionAllows("write")) return;
    recordRequestTags(resolveCacheTags(this.config, requestCtx), requestCtx);
  }

  /**
   * Cache all segments for a route (non-blocking via waitUntil)
   * Single cache entry per route request.
   * Loaders are excluded - they're always fresh unless they have their own cache() config.
   *
   * @param pathname - URL pathname for cache key generation
   * @param params - Route params for cache key generation
   * @param segments - All resolved segments to cache
   * @param isIntercept - Whether this is an intercept navigation (uses different cache key)
   */
  async cacheRoute(
    pathname: string,
    params: Record<string, string>,
    segments: ResolvedSegment[],
    isIntercept?: boolean,
  ): Promise<void> {
    if (!this.enabled || segments.length === 0) return;
    if (!this.conditionAllows("write")) return;

    const store = this.getStore();
    if (!store) return;

    const requestCtx = getRequestContext();
    const handleStore = requestCtx?._handleStore;

    if (!handleStore || !requestCtx) return;

    // Exclude loader segments - loaders are always fresh by default
    // Loaders can opt-in to caching with their own cache() config.
    // Segments above the boundary are live and never stored.
    const nonLoaderSegments = segments.filter(
      (s) => s.type !== "loader" && this.covers(s.id, s.namespace),
    );
    if (nonLoaderSegments.length === 0) return;

    const ttl = this.ttl;
    const swr = this.swr;
    this.noteRecordWindow(requestCtx, Date.now() + ttl * 1000, true);

    // Resolve cache key early (while request context is available)
    const key = await this.resolveKey(pathname, params, isIntercept);

    // Doc-namespaced scopes (the shell implicit scope and the capture's
    // composed doc scope) publish the canonical document segment key so
    // captureAndStoreShell can stamp it onto the shell entry (`docKey`).
    // Replay eligibility then requires this exact record — "any segment
    // record" previously counted unusable explicit-tier-keyed records too.
    if (this.defaultKeyPrefix === "doc" && requestCtx._shellImplicitCache) {
      requestCtx._shellImplicitCache.docKey = key;
    }

    // Resolve tags early (while request context is available, before waitUntil)
    const tags = resolveCacheTags(this.config, requestCtx);
    recordRequestTags(tags, requestCtx);

    // Check if this is a partial request (navigation) vs document request
    const isPartial = requestCtx.originalUrl.searchParams.has("_rsc_partial");

    if (INTERNAL_RANGO_DEBUG) {
      debugCacheLog(
        `[CacheScope] cacheRoute: scheduling waitUntil for ${key} (${nonLoaderSegments.length} segments, isPartial=${isPartial})`,
      );
    }

    requestCtx.waitUntil(async () => {
      if (INTERNAL_RANGO_DEBUG) {
        debugCacheLog(
          `[CacheScope] waitUntil: awaiting handleStore.settled for ${key}`,
        );
      }

      await handleStore.settled;

      if (INTERNAL_RANGO_DEBUG) {
        debugCacheLog(`[CacheScope] waitUntil: handleStore settled for ${key}`);
      }

      // For document requests: only cache if layout segments have components
      // (complete render). Parallel and route segments may legitimately have
      // null components — UI-less @meta parallels return null, and void route
      // handlers produce null when the UI lives in parallel slots/layouts.
      // Partial requests always allow null components (client already has them).
      if (!isPartial) {
        const hasIncompleteLayouts = nonLoaderSegments.some(
          (s) => s.component === null && s.type === "layout",
        );
        if (hasIncompleteLayouts) {
          const nullSegments = nonLoaderSegments
            .filter((s) => s.component === null && s.type === "layout")
            .map((s) => s.id);
          const error = new Error(
            `[CacheScope] Cache write skipped: layout segments have null components ` +
              `(${nullSegments.join(", ")}). This indicates an incomplete render — ` +
              `layout handlers must return JSX for document requests to be cacheable.`,
          );
          error.name = "CacheScopeInvariantError";
          console.error(error.message);
          return;
        }
      }

      // Collect handle data for non-loader segments only
      const handles = captureHandles(nonLoaderSegments, handleStore);
      const handleOwners = captureHandleOwners(nonLoaderSegments, handleStore);

      try {
        if (INTERNAL_RANGO_DEBUG) {
          debugCacheLog(
            `[CacheScope] waitUntil: serializing ${nonLoaderSegments.length} segments for ${key}`,
          );
        }

        // Serialize segments and Flight-encode handles in parallel. Handles go
        // through the codec (not raw into the entry) so Promise/ReactNode handle
        // values survive a JSON-serializing store — see encodeHandles.
        const { serializeSegments } = await import("./segment-codec.js");
        const flightErrors: unknown[] = [];
        const onFlightError = (error: unknown): void => {
          flightErrors.push(error);
        };
        // Each segment serializes inside its own tag scope, and the handles
        // inside one for this write: Flight re-renders their server
        // components, so their render-called tags land on the record.
        const handlesOwnerId = `${key}#handles`;
        const [serializedSegments, encodedHandles] = await Promise.all([
          Promise.all(
            nonLoaderSegments.map((segment) =>
              runInSegmentTagScope(segment.id, () =>
                serializeSegments([segment], onFlightError),
              ),
            ),
          ).then((parts) => parts.flat()),
          runInSegmentTagScope(handlesOwnerId, () =>
            encodeHandles(handles, onFlightError),
          ),
        ]);
        // Flight encodes a component that throws (an async server component in
        // the tree) or a rejected handle value as an error row and completes
        // normally; stored, every HIT would render that error until expiry.
        if (flightErrors.length > 0) throw flightErrors[0];

        const data: CachedEntryData = {
          segments: serializedSegments,
          handles: encodedHandles,
          expiresAt: Date.now() + ttl * 1000,
          tags: collectRecordTags(requestCtx, tags, [
            ...nonLoaderSegments.map((s) => s.id),
            handlesOwnerId,
          ]),
        };
        if (handleOwners && encodedHandles) data.handleOwners = handleOwners;

        if (INTERNAL_RANGO_DEBUG) {
          debugCacheLog(`[CacheScope] waitUntil: calling store.set for ${key}`);
        }

        await store.set(key, data, ttl, swr);

        if (INTERNAL_RANGO_DEBUG) {
          const segmentTypes = nonLoaderSegments.map((s) =>
            s.type === "parallel" ? s.slot : s.type,
          );
          debugCacheLog(
            `[CacheScope] Cached: ${key} (${segmentTypes.join(", ")}) ttl=${ttl}s [loaders excluded]`,
          );
        }
      } catch (error) {
        reportCacheError(
          error,
          "cache-write",
          `[CacheScope] Failed to cache ${key}`,
        );
      }
    });
  }
}

/**
 * A route cache() record's tags (#957): its config tags plus every tag its
 * content recorded under `ownerIds` (cache-tag.ts getSegmentTags — the covered
 * segments' handlers, the server components their Flight serialization
 * re-rendered, the loaders those handlers consumed, and the handle values).
 * A HIT replays all of that output, loading() subtrees included, so every one
 * of these tags describes it.
 */
function collectRecordTags(
  requestCtx: RequestContext,
  configTags: string[] | undefined,
  ownerIds: string[],
): string[] | undefined {
  const tags = new Set(configTags);
  const before = tags.size;
  for (const id of ownerIds) {
    for (const tag of getSegmentTags(requestCtx, id)) tags.add(tag);
  }
  return tags.size > before ? [...tags] : configTags;
}

/**
 * @internal The request partition of a ppr route's shell: the record key
 * that partitions the route's cache() record for this request (its `key()`,
 * else its store's keyGenerator, both given the document default key) or,
 * with no route cache(), the app store's keyGenerator result. Undefined
 * (synchronously, with no work) when neither applies: the shell key stays
 * host + path + filtered search. Resolves to null when the key is the
 * default key itself (a keyGenerator that returns it unchanged): that
 * partitions nothing, so the shell stays unpartitioned and keeps its build
 * shell. The shell's key, its read and capture, and partial replay all use
 * it, so a visitor is only served its own partition. A rejected promise is a
 * failed key resolution: the caller serves no shell.
 */
export function resolveShellPartition(
  routeScope: CacheScope | null | undefined,
  appStore: SegmentCacheStore | null | undefined,
  pathname: string,
  params: Record<string, string> | undefined,
): Promise<string | null> | undefined {
  const scope = routeScope?.enabled ? routeScope : undefined;
  const keyFn = scope && scope.config !== false ? scope.config.key : undefined;
  const store = scope ? scope.getStore() : appStore;
  if (!keyFn && !store?.keyGenerator) return undefined;
  const defaultKey = getDefaultRouteCacheKey(pathname, params, false, "doc");
  const key = scope
    ? scope.resolveKeyFrom(defaultKey)
    : resolveCacheKey(undefined, store ?? null, defaultKey, "CacheScope");
  return key.then((resolved) => (resolved === defaultKey ? null : resolved));
}

/**
 * Create a cache scope from entry's cache config. `shortCode` is the cache()
 * entry's: a scope nested in an enabled parent keeps the parent's boundary
 * (one entry covers both), any other opens its own at this entry.
 */
export function createCacheScope(
  config: { options: PartialCacheOptions | false } | undefined,
  parent: CacheScope | null = null,
  shortCode?: string,
): CacheScope | null {
  if (!config) return parent; // No config, inherit parent
  const boundary = parent?.enabled ? parent.boundary : shortCode;
  return new CacheScope(config.options, parent, undefined, boundary);
}

type ShellImplicitCacheMarker = NonNullable<
  RequestContext["_shellImplicitCache"]
>;

/**
 * Mint the implicit doc-level scope for a `_shellImplicitCache` marker: key
 * resolution under the marker's `doc` namespace against the marker's store,
 * with the marker's onHit wired as the hit observer. Shared by
 * {@link resolveShellImplicitCacheScope} (routes that derived no scope) and
 * the explicit-scope composition sites (capture doc record in the cache-store
 * middleware, seeded replay fallback in withCacheLookup) so both ends of the
 * shell contract resolve the SAME canonical document key. A document HIT
 * tail's marker carries the entry's own key (`fixedDocKey`), which wins over
 * key resolution.
 */
export function createShellImplicitDocScope(
  marker: ShellImplicitCacheMarker,
): CacheScope {
  const fixedDocKey = marker.fixedDocKey;
  const implicitScope = new CacheScope(
    {
      ttl: marker.ttl,
      swr: marker.swr,
      store: marker.store,
      ...(fixedDocKey !== undefined && { key: () => fixedDocKey }),
    },
    null,
    marker.keyPrefix,
  );
  if (marker.onHit) CACHE_HIT_OBSERVERS.set(implicitScope, marker.onHit);
  return implicitScope;
}

/**
 * The doc record scope: when the current request context carries the
 * `_shellImplicitCache` marker (a shell capture, a document HIT tail, or a
 * normal partial navigation replay), substitute an implicit doc-level scope
 * so withCacheLookup/withCacheStore treat the WHOLE matched route as a
 * cache() boundary — the shell entry IS a cache() of the handler layer, with
 * loaders as the live carve-outs (resolveFreshLoadersAndYield).
 *
 * A document HIT tail (`docTail`) always gets the implicit scope: it replays
 * the shell's own record and never consults a route-derived scope, whose
 * opt-outs the serve gate evaluated before the commit (shellServePlan). Every
 * other marker leaves an existing scope — including an explicit cache(false)
 * — in place: the consumer's cache() semantics (their ttl/swr/store/condition)
 * are never overridden. On the navigation-replay serve path the marker still
 * composes with an explicit scope downstream (withCacheLookup's seeded
 * fallback after an explicit-tier miss) — see `onExplicitHit` on
 * `_shellImplicitCache`; during a capture, recordShellCaptureDocRecord
 * (cache-store.ts) writes the record for such a scope.
 */
export function resolveShellImplicitCacheScope(
  scope: CacheScope | null,
): CacheScope | null {
  const marker = getRequestContext()?._shellImplicitCache;
  if (scope && !marker?.docTail) return scope;
  if (!marker) return null;
  return createShellImplicitDocScope(marker);
}
