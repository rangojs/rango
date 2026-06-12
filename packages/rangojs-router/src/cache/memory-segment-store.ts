/**
 * In-Memory Segment Cache Store
 *
 * Simple in-memory implementation of SegmentCacheStore.
 * Uses globalThis to survive HMR in development.
 */

import type {
  SegmentCacheStore,
  CachedEntryData,
  CacheDefaults,
  CacheGetResult,
  CacheItemResult,
  CacheItemOptions,
} from "./types.js";
import type { RequestContext } from "../server/request-context.js";
import {
  resolveTtl,
  resolveSwrWindow,
  computeExpiration,
  DEFAULT_FUNCTION_TTL,
} from "./cache-policy.js";
import { reportCacheError } from "./cache-error.js";

const CACHE_REGISTRY_KEY = "__rsc_router_segment_cache_registry__";
const RESPONSE_CACHE_REGISTRY_KEY = "__rsc_router_response_cache_registry__";
const ITEM_CACHE_REGISTRY_KEY = "__rsc_router_item_cache_registry__";
const TAG_INDEX_REGISTRY_KEY = "__rsc_router_tag_index_registry__";
const KEY_TAGS_REGISTRY_KEY = "__rsc_router_key_tags_registry__";

/**
 * Get or create a named Map from a globalThis-backed registry.
 * The registry survives HMR; individual stores are keyed by name.
 */
function getNamedMap<V>(registryKey: string, name: string): Map<string, V> {
  let registry = (globalThis as any)[registryKey] as
    | Map<string, Map<string, V>>
    | undefined;
  if (!registry) {
    registry = new Map();
    (globalThis as any)[registryKey] = registry;
  }
  let map = registry.get(name);
  if (!map) {
    map = new Map<string, V>();
    registry.set(name, map);
  }
  return map;
}

interface CachedResponseEntry {
  body: ArrayBuffer;
  status: number;
  headers: [string, string][];
  expiresAt: number;
  staleAt: number;
}

interface CachedItemEntry {
  value: string;
  /** RSC-encoded handle data (see handle-snapshot.ts encodeHandles). Stored as
   *  the encoded string by reference, identical to the JSON-serializing stores. */
  handles?: string;
  expiresAt: number;
  staleAt: number;
  tags?: string[];
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
   * Caveat: two instances constructed with the SAME name share all backing maps
   * (data + tag index), but each keeps its OWN `defaults` and `keyGenerator` from
   * its options - those are not shared. Use one instance per name, or keep the
   * options identical, to avoid surprising divergence.
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
 * In-memory segment cache store.
 *
 * Suitable for development and single-instance deployments.
 * For production with multiple instances, use a distributed store
 * like Cloudflare KV or Redis.
 *
 * Tag-index cleanup is lazy, mirroring the data maps: a tagged entry that
 * expires but is never re-read or invalidated leaves its forward+reverse index
 * entries resident until the key is reused or invalidated. This is bounded by
 * the distinct-tag count and acceptable for a dev/single-instance store.
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
export class MemorySegmentCacheStore<
  TEnv = unknown,
> implements SegmentCacheStore<TEnv> {
  private cache: Map<string, CachedEntryData>;
  private responseCache: Map<string, CachedResponseEntry>;
  private itemCache: Map<string, CachedItemEntry>;
  /** tag -> set of prefixed cache keys (seg:key, res:key, item:key) */
  private tagIndex: Map<string, Set<string>>;
  /** prefixed cache key -> set of tags (reverse index for O(tags) unregister) */
  private keyTags: Map<string, Set<string>>;
  readonly defaults?: CacheDefaults;
  readonly keyGenerator?: (
    ctx: RequestContext<TEnv>,
    defaultKey: string,
  ) => string | Promise<string>;

  constructor(options?: MemorySegmentCacheStoreOptions<TEnv>) {
    if (options?.name != null) {
      // Named stores use the globalThis registry so data survives HMR.
      // Each name gets its own isolated Map.
      this.cache = getNamedMap<CachedEntryData>(
        CACHE_REGISTRY_KEY,
        options.name,
      );
      this.responseCache = getNamedMap<CachedResponseEntry>(
        RESPONSE_CACHE_REGISTRY_KEY,
        options.name,
      );
      this.itemCache = getNamedMap<CachedItemEntry>(
        ITEM_CACHE_REGISTRY_KEY,
        options.name,
      );
      this.tagIndex = getNamedMap<Set<string>>(
        TAG_INDEX_REGISTRY_KEY,
        options.name,
      );
      this.keyTags = getNamedMap<Set<string>>(
        KEY_TAGS_REGISTRY_KEY,
        options.name,
      );
    } else {
      // Unnamed stores get a plain instance-level Map (no globalThis sharing).
      this.cache = new Map<string, CachedEntryData>();
      this.responseCache = new Map<string, CachedResponseEntry>();
      this.itemCache = new Map<string, CachedItemEntry>();
      this.tagIndex = new Map<string, Set<string>>();
      this.keyTags = new Map<string, Set<string>>();
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
      this.unregisterTags(`seg:${key}`);
      this.cache.delete(key);
      return null;
    }

    // Memory store doesn't support SWR - never triggers revalidation
    return { data: cached, shouldRevalidate: false };
  }

  async set(
    key: string,
    data: CachedEntryData,
    ttl: number,
    _swr?: number,
  ): Promise<void> {
    // Note: Memory store doesn't implement SWR - entries just expire at TTL
    // For SWR support, use CFCacheStore or similar distributed cache
    const entry: CachedEntryData = {
      ...data,
      expiresAt: Date.now() + ttl * 1000,
    };
    const prefixedKey = `seg:${key}`;
    // Always drop stale tag mappings before writing so an overwrite with
    // different (or no) tags cannot leave the previous tags pointing here.
    this.unregisterTags(prefixedKey);
    this.cache.set(key, entry);
    if (data.tags && data.tags.length > 0) {
      this.registerTags(data.tags, prefixedKey);
    }
  }

  async delete(key: string): Promise<boolean> {
    this.unregisterTags(`seg:${key}`);
    return this.cache.delete(key);
  }

  async clear(): Promise<void> {
    this.cache.clear();
    this.responseCache.clear();
    this.itemCache.clear();
    this.tagIndex.clear();
    this.keyTags.clear();
  }

  async getResponse(
    key: string,
  ): Promise<{ response: Response; shouldRevalidate: boolean } | null> {
    const cached = this.responseCache.get(key);
    if (!cached) return null;

    if (Date.now() > cached.expiresAt) {
      this.unregisterTags(`res:${key}`);
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
    tags?: string[],
  ): Promise<void> {
    try {
      // arrayBuffer() can reject (e.g. an already-consumed body). A write
      // failure must degrade to a no-op (entry simply not cached), never throw
      // up and fail the request.
      const body = await response.clone().arrayBuffer();
      // Defense-in-depth (Finding #3): never persist a per-client signal into a
      // shared store. The document-cache chokepoint already refuses these, but
      // putResponse is public and reachable directly (e.g. tag-revalidation
      // re-puts), so strip them here too.
      const headers: [string, string][] = [];
      response.headers.forEach((value, name) => {
        const lower = name.toLowerCase();
        if (lower === "set-cookie" || lower === "x-rango-keep-cache") return;
        headers.push([name, value]);
      });

      const swrWindow = resolveSwrWindow(swr, this.defaults);
      const { staleAt, expiresAt } = computeExpiration(ttl, swrWindow);

      const prefixedKey = `res:${key}`;
      this.unregisterTags(prefixedKey);
      this.responseCache.set(key, {
        body,
        status: response.status,
        headers,
        expiresAt,
        staleAt,
      });
      if (tags && tags.length > 0) {
        this.registerTags(tags, prefixedKey);
      }
    } catch (error) {
      reportCacheError(
        error,
        "cache-write",
        "[MemorySegmentCacheStore] putResponse",
      );
    }
  }

  async getItem(key: string): Promise<CacheItemResult | null> {
    const cached = this.itemCache.get(key);
    if (!cached) return null;

    const now = Date.now();
    if (now > cached.expiresAt) {
      this.unregisterTags(`item:${key}`);
      this.itemCache.delete(key);
      return null;
    }

    const isStale = now > cached.staleAt;
    return {
      value: cached.value,
      handles: cached.handles,
      shouldRevalidate: isStale,
      tags: cached.tags,
    };
  }

  async setItem(
    key: string,
    value: string,
    options?: CacheItemOptions,
  ): Promise<void> {
    const ttl = resolveTtl(options?.ttl, this.defaults, DEFAULT_FUNCTION_TTL);
    const swrWindow = resolveSwrWindow(options?.swr, this.defaults);
    const { staleAt, expiresAt } = computeExpiration(ttl, swrWindow);
    const prefixedKey = `item:${key}`;
    this.unregisterTags(prefixedKey);
    this.itemCache.set(key, {
      value,
      handles: options?.handles,
      expiresAt,
      staleAt,
      tags: options?.tags,
    });
    if (options?.tags && options.tags.length > 0) {
      this.registerTags(options.tags, prefixedKey);
    }
  }

  /**
   * Invalidate every cache entry (segment, response, item) tagged with any of
   * `tags`. Entries are dropped immediately; the next read is a miss and
   * re-renders fresh. This is the store-level primitive both updateTag() and
   * revalidateTag() delegate to. (In-process, so there is nothing to batch
   * beyond looping the tags.)
   */
  async invalidateTags(tags: string[]): Promise<void> {
    for (const tag of tags) {
      const keys = this.tagIndex.get(tag);
      if (!keys || keys.size === 0) continue;

      // Snapshot the keys before mutating the index inside the loop.
      const prefixedKeys = [...keys];

      for (const prefixedKey of prefixedKeys) {
        const colonIdx = prefixedKey.indexOf(":");
        const prefix = prefixedKey.slice(0, colonIdx);
        const rawKey = prefixedKey.slice(colonIdx + 1);

        if (prefix === "seg") {
          this.cache.delete(rawKey);
        } else if (prefix === "res") {
          this.responseCache.delete(rawKey);
        } else if (prefix === "item") {
          this.itemCache.delete(rawKey);
        }

        // Drop this key from every tag set it belonged to, not just `tag`.
        this.unregisterTags(prefixedKey);
      }
    }
  }

  /**
   * Register `tags` for a prefixed cache key in both the forward
   * (tag -> keys) and reverse (key -> tags) indexes.
   * Callers must call unregisterTags() first to clear stale mappings.
   * @internal
   */
  private registerTags(tags: string[], prefixedKey: string): void {
    let tagSet = this.keyTags.get(prefixedKey);
    if (!tagSet) {
      tagSet = new Set();
      this.keyTags.set(prefixedKey, tagSet);
    }
    for (const tag of tags) {
      tagSet.add(tag);
      let keys = this.tagIndex.get(tag);
      if (!keys) {
        keys = new Set();
        this.tagIndex.set(tag, keys);
      }
      keys.add(prefixedKey);
    }
  }

  /**
   * Remove a prefixed cache key from every tag set it belongs to.
   * Uses the reverse index so this is O(tags-per-key), not O(total-tags).
   * @internal
   */
  private unregisterTags(prefixedKey: string): void {
    const tagSet = this.keyTags.get(prefixedKey);
    if (!tagSet) return;
    for (const tag of tagSet) {
      const keys = this.tagIndex.get(tag);
      if (keys) {
        keys.delete(prefixedKey);
        if (keys.size === 0) {
          this.tagIndex.delete(tag);
        }
      }
    }
    this.keyTags.delete(prefixedKey);
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
    delete (globalThis as any)[ITEM_CACHE_REGISTRY_KEY];
    delete (globalThis as any)[TAG_INDEX_REGISTRY_KEY];
    delete (globalThis as any)[KEY_TAGS_REGISTRY_KEY];
  }
}
