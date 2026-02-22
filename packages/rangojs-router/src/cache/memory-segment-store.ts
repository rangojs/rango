/**
 * In-Memory Segment Cache Store
 *
 * Simple in-memory implementation of SegmentCacheStore.
 * Uses globalThis to survive HMR in development.
 */

import type { SegmentCacheStore, CachedEntryData, CacheDefaults, CacheGetResult } from "./types.js";
import type { RequestContext } from "../server/request-context.js";

const CACHE_REGISTRY_KEY = "__rsc_router_segment_cache_registry__";
const RESPONSE_CACHE_REGISTRY_KEY = "__rsc_router_response_cache_registry__";

/**
 * Returns the globalThis-backed registry of named cache Maps.
 * The registry itself survives HMR; individual stores are keyed by name.
 */
function getGlobalRegistry(): Map<string, Map<string, CachedEntryData>> {
  let registry = (globalThis as any)[CACHE_REGISTRY_KEY] as
    | Map<string, Map<string, CachedEntryData>>
    | undefined;
  if (!registry) {
    registry = new Map();
    (globalThis as any)[CACHE_REGISTRY_KEY] = registry;
  }
  return registry;
}

interface CachedResponseEntry {
  body: ArrayBuffer;
  status: number;
  headers: [string, string][];
  expiresAt: number;
  staleAt: number;
}

/**
 * Returns the globalThis-backed registry of named response cache Maps.
 */
function getResponseCacheRegistry(): Map<string, Map<string, CachedResponseEntry>> {
  let registry = (globalThis as any)[RESPONSE_CACHE_REGISTRY_KEY] as
    | Map<string, Map<string, CachedResponseEntry>>
    | undefined;
  if (!registry) {
    registry = new Map();
    (globalThis as any)[RESPONSE_CACHE_REGISTRY_KEY] = registry;
  }
  return registry;
}

/**
 * Options for MemorySegmentCacheStore
 */
export interface MemorySegmentCacheStoreOptions<TEnv = unknown> {
  /**
   * Optional name for this store instance. Named stores persist their
   * backing Map on globalThis so data survives Vite HMR module reloads.
   * Stores with different names get separate Maps.
   *
   * When omitted, the store uses a plain instance-level Map with no
   * globalThis sharing, which is the safest default for isolation.
   *
   * @example
   * ```typescript
   * // Two named stores are isolated from each other
   * const fast = new MemorySegmentCacheStore({ name: "fast", defaults: { ttl: 10 } });
   * const slow = new MemorySegmentCacheStore({ name: "slow", defaults: { ttl: 300 } });
   * ```
   */
  name?: string;

  /**
   * Default cache options for cache() boundaries.
   * When cache() is called without explicit ttl/swr,
   * these defaults are used.
   *
   * @example
   * ```typescript
   * const store = new MemorySegmentCacheStore({
   *   defaults: { ttl: 60, swr: 300 }
   * });
   * ```
   */
  defaults?: CacheDefaults;

  /**
   * Custom key generator applied to all cache operations.
   * Receives the full RequestContext and the default-generated key.
   *
   * @example
   * ```typescript
   * keyGenerator: (ctx, defaultKey) => {
   *   const locale = ctx.cookie('locale') || 'en';
   *   return `${locale}:${defaultKey}`;
   * }
   * ```
   */
  keyGenerator?: (
    ctx: RequestContext<TEnv>,
    defaultKey: string
  ) => string | Promise<string>;
}

/**
 * In-memory segment cache store.
 *
 * Suitable for development and single-instance deployments.
 * For production with multiple instances, use a distributed store
 * like Cloudflare KV or Redis.
 *
 * @example
 * ```typescript
 * // Basic usage
 * const store = new MemorySegmentCacheStore();
 *
 * // With defaults for cache() boundaries
 * const store = new MemorySegmentCacheStore({
 *   defaults: { ttl: 60 }
 * });
 *
 * createRSCHandler({
 *   router,
 *   cache: { store }
 * })
 * ```
 */
export class MemorySegmentCacheStore<TEnv = unknown> implements SegmentCacheStore<TEnv> {
  private cache: Map<string, CachedEntryData>;
  private responseCache: Map<string, CachedResponseEntry>;
  readonly defaults?: CacheDefaults;
  readonly keyGenerator?: (
    ctx: RequestContext<TEnv>,
    defaultKey: string
  ) => string | Promise<string>;

  constructor(options?: MemorySegmentCacheStoreOptions<TEnv>) {
    if (options?.name != null) {
      // Named stores use the globalThis registry so data survives HMR.
      // Each name gets its own isolated Map.
      const registry = getGlobalRegistry();
      let map = registry.get(options.name);
      if (!map) {
        map = new Map<string, CachedEntryData>();
        registry.set(options.name, map);
      }
      this.cache = map;

      const responseRegistry = getResponseCacheRegistry();
      let responseMap = responseRegistry.get(options.name);
      if (!responseMap) {
        responseMap = new Map<string, CachedResponseEntry>();
        responseRegistry.set(options.name, responseMap);
      }
      this.responseCache = responseMap;
    } else {
      // Unnamed stores get a plain instance-level Map (no globalThis sharing).
      this.cache = new Map<string, CachedEntryData>();
      this.responseCache = new Map<string, CachedResponseEntry>();
    }
    this.defaults = options?.defaults;
    this.keyGenerator = options?.keyGenerator;
  }

  async get(key: string): Promise<CacheGetResult | null> {
    const cached = this.cache.get(key);

    if (!cached) {
      return null;
    }

    // Check expiration
    if (Date.now() > cached.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    // Memory store doesn't support SWR - never triggers revalidation
    return { data: cached, shouldRevalidate: false };
  }

  async set(key: string, data: CachedEntryData, ttl: number, _swr?: number): Promise<void> {
    // Note: Memory store doesn't implement SWR - entries just expire at TTL
    // For SWR support, use CFCacheStore or similar distributed cache
    const entry: CachedEntryData = {
      ...data,
      expiresAt: Date.now() + ttl * 1000,
    };
    this.cache.set(key, entry);
  }

  async delete(key: string): Promise<boolean> {
    return this.cache.delete(key);
  }

  async clear(): Promise<void> {
    this.cache.clear();
    this.responseCache.clear();
  }

  async getResponse(
    key: string,
  ): Promise<{ response: Response; shouldRevalidate: boolean } | null> {
    const cached = this.responseCache.get(key);
    if (!cached) return null;

    if (Date.now() > cached.expiresAt) {
      this.responseCache.delete(key);
      return null;
    }

    const isStale = cached.staleAt > 0 && Date.now() > cached.staleAt;
    const headers = new Headers(cached.headers);
    return {
      response: new Response(cached.body, {
        status: cached.status,
        headers,
      }),
      shouldRevalidate: isStale,
    };
  }

  async putResponse(
    key: string,
    response: Response,
    ttl: number,
    swr?: number,
  ): Promise<void> {
    const body = await response.clone().arrayBuffer();
    const headers: [string, string][] = [];
    response.headers.forEach((value, name) => {
      headers.push([name, value]);
    });

    const swrWindow = swr ?? this.defaults?.swr ?? 0;
    const staleAt = Date.now() + ttl * 1000;
    const expiresAt = staleAt + swrWindow * 1000;

    this.responseCache.set(key, {
      body,
      status: response.status,
      headers,
      expiresAt,
      staleAt,
    });
  }

  /**
   * Get cache statistics for debugging purposes.
   * @internal
   */
  getStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }

  /**
   * Reset the global cache registry.
   * Useful for test isolation - call this in beforeEach to ensure
   * tests don't share cache state via globalThis.
   *
   * @example
   * ```typescript
   * beforeEach(() => {
   *   MemorySegmentCacheStore.resetGlobalCache();
   * });
   * ```
   */
  static resetGlobalCache(): void {
    delete (globalThis as any)[CACHE_REGISTRY_KEY];
    delete (globalThis as any)[RESPONSE_CACHE_REGISTRY_KEY];
  }
}
