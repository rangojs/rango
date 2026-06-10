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
import { serializeSegments, deserializeSegments } from "./segment-codec.js";
import { captureHandles, restoreHandles } from "./handle-snapshot.js";
import { sortedSearchString, sortedRouteParams } from "./cache-key-utils.js";
import {
  DEFAULT_ROUTE_TTL,
  resolveCacheKey,
  resolveCacheStore,
  resolveTagsOption,
} from "./cache-policy.js";
import type { RequestContext } from "../server/request-context.js";

/**
 * Resolve tags for a cache() boundary from its config (static array or
 * function of ctx). Thin wrapper over the shared resolveTagsOption so the
 * cache() DSL and loader caching resolve tags identically.
 * @internal
 */
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

// ============================================================================
// Key Generation (internal)
// ============================================================================

/**
 * Generate cache key base from host, pathname, route params, and search params.
 * Host is included to prevent cross-host cache collisions on shared stores.
 * Route params and search params are sorted alphabetically for deterministic keys.
 * Internal _rsc* and __* query params are excluded.
 * @internal
 */
function getCacheKeyBase(
  host: string,
  pathname: string,
  params?: Record<string, string>,
  searchParams?: URLSearchParams,
): string {
  const paramStr = sortedRouteParams(params);
  const searchStr = searchParams ? sortedSearchString(searchParams) : "";

  let key = `${host}${pathname}`;
  if (paramStr) key += `:${paramStr}`;
  if (searchStr) key += `?${searchStr}`;
  return key;
}

/**
 * Generate default cache key for a route request.
 * Includes pathname, route params, and user-facing search params for
 * correct scoping. Internal _rsc* params are excluded.
 * Includes request type prefix since they produce different segment sets:
 * - doc: document requests (full page load)
 * - partial: navigation requests (client-side navigation)
 * - intercept: intercept navigation (modal/overlay routes)
 * @internal
 */
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

  return `${prefix}:${getCacheKeyBase(host, pathname, params, searchParams)}`;
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
   * Get effective TTL from config or store defaults
   */
  get ttl(): number {
    if (this.config === false) return 0;

    // Explicit TTL in cache() options
    if (this.config.ttl !== undefined) {
      return this.config.ttl;
    }

    // Fall back to store defaults (explicit store first, then app-level)
    const store = this.getStore();
    if (store?.defaults?.ttl !== undefined) {
      return store.defaults.ttl;
    }

    // Hardcoded fallback
    return DEFAULT_ROUTE_TTL;
  }

  /**
   * Get SWR window from config or store defaults
   */
  get swr(): number | undefined {
    if (this.config === false) return undefined;

    // Explicit SWR in cache() options
    if (this.config.swr !== undefined) {
      return this.config.swr;
    }

    // Fall back to store defaults
    const store = this.getStore();
    return store?.defaults?.swr;
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

    // Resolve cache key (may use custom key functions)
    const key = await this.resolveKey(pathname, params, isIntercept);

    try {
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
      let segments: ResolvedSegment[];
      try {
        segments = await deserializeSegments(cached.segments);
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

      // Replay handle data
      const handleStore = _getRequestContext()?._handleStore;
      if (handleStore) {
        restoreHandles(cached.handles, handleStore);
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
      reportCacheError(error, "cache-read", `[CacheScope] lookup ${key}`);
      return null;
    }
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
      const handles = captureHandles(nonLoaderSegments, handleStore);

      try {
        if (INTERNAL_RANGO_DEBUG) {
          debugCacheLog(
            `[CacheScope] waitUntil: serializing ${nonLoaderSegments.length} segments for ${key}`,
          );
        }

        // Serialize non-loader segments only
        const serializedSegments = await serializeSegments(nonLoaderSegments);

        const data: CachedEntryData = {
          segments: serializedSegments,
          handles,
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
