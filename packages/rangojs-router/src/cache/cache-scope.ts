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
import type {
  SegmentCacheStore,
  CachedEntryData,
} from "./types.js";
import { getRequestContext } from "../server/request-context.js";
import { serializeSegments, deserializeSegments } from "./segment-codec.js";
import { captureHandles, restoreHandles } from "./handle-snapshot.js";

// Re-export codec functions for backwards compatibility.
// Existing call sites import these from cache-scope.ts via dynamic import.
export { deserializeComponent, serializeSegments, deserializeSegments } from "./segment-codec.js";

// ============================================================================
// Constants
// ============================================================================

/** Default TTL when no explicit value or store defaults are configured */
const DEFAULT_TTL_SECONDS = 60;

// ============================================================================
// Key Generation (internal)
// ============================================================================

/**
 * Generate cache key base from pathname and params.
 * Params are sorted alphabetically for consistent key generation.
 * @internal
 */
function getCacheKeyBase(
  pathname: string,
  params?: Record<string, string>
): string {
  const paramStr = params
    ? Object.entries(params)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(
          ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`,
        )
        .join("&")
    : "";

  return paramStr ? `${pathname}:${paramStr}` : pathname;
}

/**
 * Generate default cache key for a route request.
 * Single cache entry per route - uses pathname as the key.
 * Includes request type prefix since they produce different segment sets:
 * - doc: document requests (full page load)
 * - partial: navigation requests (client-side navigation)
 * - intercept: intercept navigation (modal/overlay routes)
 * @internal
 */
function getDefaultRouteCacheKey(
  pathname: string,
  params?: Record<string, string>,
  isIntercept?: boolean
): string {
  const ctx = getRequestContext();
  const isPartial = ctx?.url.searchParams.has("_rsc_partial") ?? false;

  // Intercept navigations get their own cache namespace
  const prefix = isIntercept ? "intercept" : isPartial ? "partial" : "doc";

  return `${prefix}:${getCacheKeyBase(pathname, params)}`;
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
    parent: CacheScope | null = null
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
    return DEFAULT_TTL_SECONDS;
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
    // Explicit store from cache() options takes precedence
    if (this.explicitStore) {
      return this.explicitStore;
    }
    // Fall back to app-level store from request context
    const ctx = getRequestContext();
    return ctx?._cacheStore ?? null;
  }

  /**
   * Resolve the cache key using custom key functions or default generation.
   *
   * Resolution priority:
   * 1. Route-level `key` function (full override)
   * 2. Store-level `keyGenerator` (modifies default key)
   * 3. Default key generation (prefix:pathname:params)
   *
   * @internal
   */
  private async resolveKey(
    pathname: string,
    params: Record<string, string>,
    isIntercept?: boolean
  ): Promise<string> {
    const requestCtx = getRequestContext();
    if (!requestCtx) {
      // Fallback to default key if no request context
      return getDefaultRouteCacheKey(pathname, params, isIntercept);
    }

    // Priority 1: Route-level key function (full override)
    if (this.config !== false && this.config.key) {
      try {
        const customKey = await this.config.key(requestCtx);
        return customKey;
      } catch (error) {
        console.error(`[CacheScope] Custom key function failed, using default:`, error);
        return getDefaultRouteCacheKey(pathname, params, isIntercept);
      }
    }

    // Generate default key
    const defaultKey = getDefaultRouteCacheKey(pathname, params, isIntercept);

    // Priority 2: Store-level keyGenerator (modifies default key)
    const store = this.getStore();
    if (store?.keyGenerator) {
      try {
        const modifiedKey = await store.keyGenerator(requestCtx, defaultKey);
        return modifiedKey;
      } catch (error) {
        console.error(`[CacheScope] Store keyGenerator failed, using default:`, error);
        return defaultKey;
      }
    }

    // Priority 3: Default key
    return defaultKey;
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
    isIntercept?: boolean
  ): Promise<{
    segments: ResolvedSegment[];
    shouldRevalidate: boolean;
  } | null> {
    if (!this.enabled) return null;

    const store = this.getStore();
    if (!store) return null;

    // Resolve cache key (may use custom key functions)
    const key = await this.resolveKey(pathname, params, isIntercept);

    try {
      const result = await store.get(key);

      if (!result) {
        console.log(`[CacheScope] MISS: ${key}`);
        return null;
      }

      const { data: cached, shouldRevalidate } = result;

      // Deserialize segments
      const segments = await deserializeSegments(cached.segments);

      // Replay handle data
      const handleStore = getRequestContext()?._handleStore;
      if (handleStore) {
        restoreHandles(cached.handles, handleStore);
      }

      const segmentTypes = segments.map((s) =>
        s.type === "parallel" ? s.slot : s.type
      );
      console.log(
        `[CacheScope] ${shouldRevalidate ? "STALE" : "HIT"}: ${key} (${segmentTypes.join(", ")})`
      );

      return { segments, shouldRevalidate };
    } catch (error) {
      console.error(`[CacheScope] Failed to lookup ${key}:`, error);
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
    isIntercept?: boolean
  ): Promise<void> {
    if (!this.enabled || segments.length === 0) return;

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

    // Check if this is a partial request (navigation) vs document request
    const isPartial = requestCtx.url.searchParams.has("_rsc_partial");

    requestCtx.waitUntil(async () => {
      await handleStore.settled;

      // For document requests: only cache if ALL segments have components (complete render)
      // For partial requests: null components are expected (client already has them)
      if (!isPartial) {
        const hasAllComponents = nonLoaderSegments.every(
          (s) => s.component !== null
        );
        if (!hasAllComponents) return;
      }

      // Collect handle data for non-loader segments only
      const handles = captureHandles(nonLoaderSegments, handleStore);

      try {
        // Serialize non-loader segments only
        const serializedSegments = await serializeSegments(nonLoaderSegments);

        const data: CachedEntryData = {
          segments: serializedSegments,
          handles,
          expiresAt: Date.now() + ttl * 1000,
        };

        await store.set(key, data, ttl, swr);

        const segmentTypes = nonLoaderSegments.map((s) =>
          s.type === "parallel" ? s.slot : s.type
        );
        console.log(
          `[CacheScope] Cached: ${key} (${segmentTypes.join(", ")}) ttl=${ttl}s [loaders excluded]`
        );
      } catch (error) {
        console.error(`[CacheScope] Failed to cache ${key}:`, error);
      }
    });
  }
}

/**
 * Create a cache scope from entry's cache config
 */
export function createCacheScope(
  config: { options: PartialCacheOptions | false } | undefined,
  parent: CacheScope | null = null
): CacheScope | null {
  if (!config) return parent; // No config, inherit parent
  return new CacheScope(config.options, parent);
}
