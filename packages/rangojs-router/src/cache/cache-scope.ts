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
import { INTERNAL_RANGO_DEBUG } from "../internal-debug.js";
import {
  getRequestContext,
  _getRequestContext,
} from "../server/request-context.js";
import { recordRequestTags } from "./cache-tag.js";
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
): string {
  const ctx = getRequestContext();
  const isPartial = ctx?.originalUrl?.searchParams.has("_rsc_partial") ?? false;
  const searchParams = ctx?.url.searchParams;
  const host = ctx?.url.host ?? "localhost";

  // Intercept navigations get their own cache namespace
  const prefix = isIntercept ? "intercept" : isPartial ? "partial" : "doc";

  return `${prefix}:${cacheKeyBase(host, pathname, searchParams, params)}`;
}

// ============================================================================
// CacheScope
// ============================================================================

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
  ) {
    this.config = config;
    this.parent = parent;
    // Extract and store explicit store reference
    this.explicitStore = config !== false ? config.store : undefined;
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
  private async resolveKey(
    pathname: string,
    params: Record<string, string>,
    isIntercept?: boolean,
  ): Promise<string> {
    const defaultKey = getDefaultRouteCacheKey(pathname, params, isIntercept);
    const keyFn = this.config !== false ? this.config.key : undefined;
    return resolveCacheKey(keyFn, this.getStore(), defaultKey, "CacheScope");
  }

  /**
   * Evaluate the cache `condition` predicate. Returns false (skip the cache
   * operation) when the predicate returns false or throws; returns true when
   * there is no condition or no request context to evaluate it against.
   */
  private conditionAllows(op: "read" | "write"): boolean {
    if (this.config === false || !this.config.condition) return true;
    const requestCtx = getRequestContext();
    if (!requestCtx) return true;
    try {
      if (!this.config.condition(requestCtx)) {
        debugCacheLog(
          `[CacheScope] condition returned false, skipping cache ${op}`,
        );
        return false;
      }
      return true;
    } catch (error) {
      console.error(
        `[CacheScope] condition function threw, skipping cache ${op}:`,
        error,
      );
      return false;
    }
  }

  /**
   * Lookup cached segments for a route (single cache entry per request).
   * Returns { segments, shouldRevalidate } or null if cache miss.
   *
   * @param pathname - URL pathname for cache key generation
   * @param params - Route params for cache key generation
   * @param isIntercept - Whether this is an intercept navigation (uses different cache key)
   */
  async lookupRoute(
    pathname: string,
    params: Record<string, string>,
    isIntercept?: boolean,
  ): Promise<{
    segments: ResolvedSegment[];
    shouldRevalidate: boolean;
  } | null> {
    if (!this.enabled) return null;
    if (!this.conditionAllows("read")) return null;

    const store = this.getStore();
    if (!store) return null;

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

      if (!result) {
        debugCacheLog(`[CacheScope] MISS: ${key}`);
        return null;
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
      // seeded record and degraded to the full tail.
      let segments: ResolvedSegment[];
      try {
        const codec = await import("./segment-codec.js");
        segments = _getRequestContext()?._shellFragmentPayload
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
        return null;
      }

      // A hit serves content that was tagged at write time, so the document
      // tag union must include this entry's tags for updateTag()/revalidateTag()
      // to invalidate any full-page entry built on top of it. The write path
      // records via cacheRoute (resolveCacheTags); the hit path records here.
      recordRequestTags(cached.tags);

      // Replay handle data. An empty string means the route pushed no handles —
      // skip the decode entirely (the common case). Otherwise decode the
      // Flight-encoded blob; a decode failure skips handle restore but keeps the
      // valid cached segments.
      const handleStore = _getRequestContext()?._handleStore;
      if (handleStore && cached.handles) {
        const handlesRecord = await decodeHandles(cached.handles);
        if (handlesRecord) {
          restoreHandles(handlesRecord, handleStore);
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

      return { segments, shouldRevalidate };
    } catch (error) {
      // Covers a store.get() failure AND a throwing consumer key()/keyGenerator
      // (resolveKey). Either way degrade to a cache miss so the render proceeds.
      reportCacheError(
        error,
        "cache-read",
        `[CacheScope] lookup ${key ?? "(key resolution failed)"}`,
      );
      return null;
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
    // Loaders can opt-in to caching with their own cache() config
    const nonLoaderSegments = segments.filter((s) => s.type !== "loader");
    if (nonLoaderSegments.length === 0) return;

    const ttl = this.ttl;
    const swr = this.swr;

    // Resolve cache key early (while request context is available)
    const key = await this.resolveKey(pathname, params, isIntercept);

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
      const handles = captureHandles(
        nonLoaderSegments,
        handleStore,
        requestCtx._shellCaptureLoaderHandleValues,
      );

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
        const [serializedSegments, encodedHandles] = await Promise.all([
          serializeSegments(nonLoaderSegments),
          encodeHandles(handles),
        ]);

        const data: CachedEntryData = {
          segments: serializedSegments,
          handles: encodedHandles,
          expiresAt: Date.now() + ttl * 1000,
          tags,
        };

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
 * Create a cache scope from entry's cache config
 */
export function createCacheScope(
  config: { options: PartialCacheOptions | false } | undefined,
  parent: CacheScope | null = null,
): CacheScope | null {
  if (!config) return parent; // No config, inherit parent
  return new CacheScope(config.options, parent);
}

/**
 * Shell fast path: when the route tree derived NO cache scope and the current
 * request context carries the `_shellImplicitCache` marker (a shell capture,
 * or a HIT tail serving an eligible entry), substitute an implicit doc-level
 * scope so withCacheLookup/withCacheStore treat the WHOLE matched route as a
 * cache() boundary — the shell entry IS a cache() of the handler layer, with
 * loaders as the live carve-outs (resolveFreshLoadersAndYield).
 *
 * An existing scope — including an explicit cache(false) opt-out — always
 * wins: the consumer's cache() semantics (their ttl/swr/store/condition) are
 * never overridden, and cache(false) keeps the tail on the full handler
 * re-run path.
 */
export function resolveShellImplicitCacheScope(
  scope: CacheScope | null,
): CacheScope | null {
  if (scope) return scope;
  const marker = getRequestContext()?._shellImplicitCache;
  if (!marker) return null;
  return new CacheScope(
    { ttl: marker.ttl, swr: marker.swr, store: marker.store },
    null,
  );
}
