/**
 * In-Memory Segment Cache Store
 *
 * Simple in-memory implementation of SegmentCacheStore.
 * Uses globalThis to survive HMR in development.
 */

import type {
  CacheStoreScope,
  SegmentCacheStore,
  CachedEntryData,
  CacheDefaults,
  CacheGetResult,
  CacheItemResult,
  CacheItemOptions,
  ShellCacheEntry,
} from "./types.js";
import type { RequestContext } from "../server/request-context.js";
import { isPerClientSignalHeader } from "../browser/cookie-name.js";
import {
  resolveTtl,
  resolveSwrWindow,
  computeExpiration,
  DEFAULT_FUNCTION_TTL,
} from "./cache-policy.js";
import { reportCacheError } from "./cache-error.js";
import { responseStartedAt } from "./invalidation-order.js";
import {
  readRecord,
  type FamilyPolicy,
  type RecordBackend,
  type RecordEnv,
  type RecordFamily,
  type RecordMeta,
} from "./record-core.js";

const CACHE_REGISTRY_KEY = "__rsc_router_segment_cache_registry__";
const RESPONSE_CACHE_REGISTRY_KEY = "__rsc_router_response_cache_registry__";
const ITEM_CACHE_REGISTRY_KEY = "__rsc_router_item_cache_registry__";
const SHELL_CACHE_REGISTRY_KEY = "__rsc_router_shell_cache_registry__";
const TAG_INDEX_REGISTRY_KEY = "__rsc_router_tag_index_registry__";
const KEY_TAGS_REGISTRY_KEY = "__rsc_router_key_tags_registry__";
const TAG_INVALIDATED_AT_REGISTRY_KEY =
  "__rsc_router_tag_invalidated_at_registry__";

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
  handles?: string;
  expiresAt: number;
  staleAt: number;
  tags?: string[];
}

interface CachedShellEntry {
  entry: ShellCacheEntry;
  expiresAt: number;
  staleAt: number;
  tags?: string[];
}

/** The tag-index prefix of each family's keys (`seg:key`, ...). */
const FAMILY_PREFIX: Record<RecordFamily, string> = {
  segment: "seg",
  response: "res",
  item: "item",
  shell: "shell",
};

/**
 * The record reads of the maps. They hold live objects: no decode, no
 * corrupt record, no backend read to fail. A segment entry has no stale
 * window (`set` ignores swr), so it never revalidates; the other families
 * revalidate once stale, with no claim.
 */
function liveRead<T>(
  family: RecordFamily,
  debugOp: string,
  meta: (entry: T) => RecordMeta,
): FamilyPolicy<T, T, string, "miss"> {
  return {
    family,
    debugOp,
    label: `[MemorySegmentCacheStore] ${debugOp}`,
    onReadError: "miss",
    decode: (raw) => raw as T,
    meta,
  };
}

function swrMeta(entry: { staleAt: number; expiresAt: number }): RecordMeta {
  return { staleAt: entry.staleAt, expiresAt: entry.expiresAt };
}

const SEGMENT_READ = liveRead<CachedEntryData>("segment", "get", (entry) => ({
  staleAt: 0,
  expiresAt: entry.expiresAt,
}));
const RESPONSE_READ = liveRead<CachedResponseEntry>(
  "response",
  "getResponse",
  swrMeta,
);
const ITEM_READ = liveRead<CachedItemEntry>("item", "getItem", swrMeta);
const SHELL_READ = liveRead<CachedShellEntry>("shell", "getShell", swrMeta);

/** No debug sink, no tag mask: invalidateTags deletes tagged entries. */
const MEMORY_READS: RecordEnv = {};

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

  /**
   * Maximum number of entries kept per internal family (segment, response,
   * item, shell). On insert, once a family reaches the cap its oldest entry is
   * evicted FIFO (insertion order) and its tag-index entries are cleaned up, so
   * a long-lived instance can't grow without bound. Lazy TTL expiry still runs
   * independently. Defaults to DEFAULT_MAX_ENTRIES (1000).
   *
   * @example
   * ```typescript
   * const store = new MemorySegmentCacheStore({ maxEntries: 500 });
   * ```
   */
  maxEntries?: number;

  /**
   * Where an entry this store writes can be read; what `router.prerender()`
   * checks before warming a route. Defaults to `"local"`: the maps live in one
   * process, and the router cannot tell one long-running server from several
   * replicas or serverless instances, so a warm into it is refused in
   * production. Set `"global"` only when exactly one process serves the app
   * (a single Node server); a warm then reports `warmed`. Under the Vite dev
   * server a `"local"` instance already counts as shared.
   *
   * Like `defaults` and `keyGenerator`, the scope is per instance: two
   * instances with the same `name` share their maps but each declares its own
   * scope. Keep them identical.
   *
   * @example
   * ```typescript
   * const store = new MemorySegmentCacheStore({ scope: "global" });
   * ```
   */
  scope?: CacheStoreScope;
}

/** Default per-family entry cap for MemorySegmentCacheStore (FIFO eviction). */
const DEFAULT_MAX_ENTRIES = 1000;

/**
 * In-memory segment cache store.
 *
 * Suitable for development and single-instance deployments.
 * For production with multiple instances, use a distributed store
 * like Cloudflare KV or Redis.
 *
 * Each family is size-capped at `maxEntries` (default 1000) with FIFO eviction
 * on insert, so a long-lived instance can't grow unbounded; TTL expiry stays
 * lazy on top of that.
 *
 * Tag-index cleanup is lazy, mirroring the data maps: a tagged entry that
 * expires but is never re-read or invalidated leaves its forward+reverse index
 * entries resident until the key is reused, invalidated, or FIFO-evicted. This
 * is bounded by the distinct-tag count and acceptable for a dev/single-instance
 * store. FIFO eviction unregisters the evicted key's tags, so the tag maps do
 * not outlive the capped data maps.
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
  /**
   * SegmentCacheStore.scope: "local" unless `options.scope` says otherwise, so
   * router.prerender() refuses to warm into these maps in production. Under
   * the Vite dev server the gate counts a "local" instance as shared
   * (store-scope.ts resolveWarmStoreScope).
   */
  readonly scope: CacheStoreScope;
  readonly supportsPassiveShellReads: true = true;
  private cache: Map<string, CachedEntryData>;
  private responseCache: Map<string, CachedResponseEntry>;
  private itemCache: Map<string, CachedItemEntry>;
  private shellCache: Map<string, CachedShellEntry>;
  /** tag -> set of prefixed cache keys (seg:key, res:key, item:key, shell:key) */
  private tagIndex: Map<string, Set<string>>;
  /** prefixed cache key -> set of tags (reverse index for O(tags) unregister) */
  private keyTags: Map<string, Set<string>>;
  /**
   * tag -> epoch ms of its latest invalidateTags() call. Runtime capture races
   * and immutable build shells are gated by comparing these markers with the
   * shell generation start. Per-isolate, like every other map here.
   */
  private tagInvalidatedAt: Map<string, number>;
  readonly defaults?: CacheDefaults;
  readonly keyGenerator?: (
    ctx: RequestContext<TEnv>,
    defaultKey: string,
  ) => string | Promise<string>;
  /** Per-family FIFO entry cap. */
  readonly maxEntries: number;
  /**
   * The maps as the record core's backend. Synchronous: a read settles and a
   * write lands before the call returns.
   */
  private readonly backend: RecordBackend;

  constructor(options?: MemorySegmentCacheStoreOptions<TEnv>) {
    if (options?.name != null) {
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
      this.shellCache = getNamedMap<CachedShellEntry>(
        SHELL_CACHE_REGISTRY_KEY,
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
      this.tagInvalidatedAt = getNamedMap<number>(
        TAG_INVALIDATED_AT_REGISTRY_KEY,
        options.name,
      );
    } else {
      this.cache = new Map<string, CachedEntryData>();
      this.responseCache = new Map<string, CachedResponseEntry>();
      this.itemCache = new Map<string, CachedItemEntry>();
      this.shellCache = new Map<string, CachedShellEntry>();
      this.tagIndex = new Map<string, Set<string>>();
      this.keyTags = new Map<string, Set<string>>();
      this.tagInvalidatedAt = new Map<string, number>();
    }
    this.defaults = options?.defaults;
    this.keyGenerator = options?.keyGenerator;
    this.maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.scope = options?.scope ?? "local";
    const maps: Record<RecordFamily, Map<string, unknown>> = {
      segment: this.cache,
      response: this.responseCache,
      item: this.itemCache,
      shell: this.shellCache,
    };
    this.backend = {
      read: (key, family) => maps[family].get(key),
      write: (key, family, record, { tags }) => {
        const map = maps[family];
        const prefix = FAMILY_PREFIX[family];
        const prefixedKey = `${prefix}:${key}`;
        this.unregisterTags(prefixedKey);
        this.evictIfNeeded(map, key, prefix);
        map.set(key, record);
        if (tags && tags.length > 0) {
          this.registerTags(tags, prefixedKey);
        }
      },
      remove: (key, family) => {
        this.unregisterTags(`${FAMILY_PREFIX[family]}:${key}`);
        maps[family].delete(key);
      },
    };
  }

  /**
   * FIFO cap enforcement, called before inserting `incomingKey` into `map`.
   * When the key is new and the family is at capacity, the oldest entries are
   * evicted in insertion order and their tag-index entries unregistered (so the
   * tag maps don't outlive the capped data map). Overwriting an existing key
   * grows nothing, so it is a no-op.
   */
  private evictIfNeeded<V>(
    map: Map<string, V>,
    incomingKey: string,
    prefix: string,
  ): void {
    if (map.has(incomingKey)) return;
    while (map.size >= this.maxEntries) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
      this.unregisterTags(`${prefix}:${oldest}`);
    }
  }

  async get(key: string): Promise<CacheGetResult | null> {
    const read = await readRecord(
      this.backend,
      key,
      SEGMENT_READ,
      MEMORY_READS,
    );
    // Memory store doesn't support SWR - never triggers revalidation
    return read && { data: read.record, shouldRevalidate: false };
  }

  async set(
    key: string,
    data: CachedEntryData,
    ttl: number,
    _swr?: number,
  ): Promise<void> {
    if (this.invalidatedAfter(data.tags, data.taggedAt)) return;
    const entry: CachedEntryData = {
      ...data,
      expiresAt: Date.now() + ttl * 1000,
    };
    this.backend.write(key, "segment", entry, {
      ttlSeconds: ttl,
      tags: data.tags,
      label: "[MemorySegmentCacheStore] set",
    });
  }

  async delete(key: string): Promise<boolean> {
    this.unregisterTags(`seg:${key}`);
    return this.cache.delete(key);
  }

  async clear(): Promise<void> {
    this.cache.clear();
    this.responseCache.clear();
    this.itemCache.clear();
    this.shellCache.clear();
    this.tagIndex.clear();
    this.keyTags.clear();
  }

  async getResponse(
    key: string,
  ): Promise<{ response: Response; shouldRevalidate: boolean } | null> {
    const read = await readRecord(
      this.backend,
      key,
      RESPONSE_READ,
      MEMORY_READS,
    );
    if (!read) return null;
    const cached = read.record;
    const headers = new Headers(cached.headers);
    return {
      response: new Response(cached.body, {
        status: cached.status,
        headers,
      }),
      shouldRevalidate: read.shouldRevalidate,
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
      const startedAt = responseStartedAt(response);
      const body = await response.clone().arrayBuffer();
      const headers: [string, string][] = [];
      response.headers.forEach((value, name) => {
        if (isPerClientSignalHeader(name)) return;
        headers.push([name, value]);
      });

      const swrWindow = resolveSwrWindow(swr, this.defaults);
      const { staleAt, expiresAt } = computeExpiration(ttl, swrWindow);

      // After the last await before the write.
      if (this.invalidatedAfter(tags, startedAt)) return;
      const entry: CachedResponseEntry = {
        body,
        status: response.status,
        headers,
        expiresAt,
        staleAt,
      };
      this.backend.write(key, "response", entry, {
        ttlSeconds: ttl,
        tags,
        label: "[MemorySegmentCacheStore] putResponse",
      });
    } catch (error) {
      reportCacheError(
        error,
        "cache-write",
        "[MemorySegmentCacheStore] putResponse",
      );
    }
  }

  async getItem(key: string): Promise<CacheItemResult | null> {
    const read = await readRecord(this.backend, key, ITEM_READ, MEMORY_READS);
    if (!read) return null;
    const cached = read.record;
    return {
      value: cached.value,
      handles: cached.handles,
      shouldRevalidate: read.shouldRevalidate,
      tags: cached.tags,
    };
  }

  async setItem(
    key: string,
    value: string,
    options?: CacheItemOptions,
  ): Promise<void> {
    if (this.invalidatedAfter(options?.tags, options?.startedAt)) return;
    const ttl = resolveTtl(options?.ttl, this.defaults, DEFAULT_FUNCTION_TTL);
    const swrWindow = resolveSwrWindow(options?.swr, this.defaults);
    const { staleAt, expiresAt } = computeExpiration(ttl, swrWindow);
    const entry: CachedItemEntry = {
      value,
      handles: options?.handles,
      expiresAt,
      staleAt,
      tags: options?.tags,
    };
    this.backend.write(key, "item", entry, {
      ttlSeconds: ttl,
      tags: options?.tags,
      label: "[MemorySegmentCacheStore] setItem",
    });
  }

  async getShell(
    key: string,
  ): Promise<{ entry: ShellCacheEntry; shouldRevalidate?: boolean } | null> {
    const read = await readRecord(this.backend, key, SHELL_READ, MEMORY_READS);
    // SWR mirrors the item family: stale within the swr window still serves, and
    // signals shouldRevalidate so the middleware schedules a background recapture.
    return (
      read && {
        entry: read.record.entry,
        shouldRevalidate: read.shouldRevalidate,
      }
    );
  }

  async putShell(
    key: string,
    entry: ShellCacheEntry,
    ttlSeconds?: number,
    swrSeconds?: number,
    tags?: string[],
  ): Promise<"stored" | "invalidated"> {
    if (
      tags &&
      tags.length > 0 &&
      this.tagsInvalidatedSince(tags, entry.createdAt)
    ) {
      return "invalidated";
    }
    const ttl = resolveTtl(ttlSeconds, this.defaults, DEFAULT_FUNCTION_TTL);
    const swrWindow = resolveSwrWindow(swrSeconds, this.defaults);
    const { staleAt, expiresAt } = computeExpiration(ttl, swrWindow);
    const record: CachedShellEntry = { entry, expiresAt, staleAt, tags };
    this.backend.write(key, "shell", record, {
      ttlSeconds: ttl,
      tags,
      label: "[MemorySegmentCacheStore] putShell",
    });
    return "stored";
  }

  async isTagsInvalidatedSince(
    tags: string[],
    sinceMs: number,
  ): Promise<boolean> {
    return this.tagsInvalidatedSince(tags, sinceMs);
  }

  /**
   * A tag invalidated in a millisecond after the write's execution started
   * (#1068). Strictly after: the start's own millisecond is ambiguous, and
   * invalidation-order.ts orders those exactly.
   */
  private invalidatedAfter(
    tags: readonly string[] | undefined,
    startedAt: number | undefined,
  ): boolean {
    if (!tags || tags.length === 0 || startedAt === undefined) return false;
    return this.tagsInvalidatedSince(tags, startedAt + 1);
  }

  private tagsInvalidatedSince(
    tags: readonly string[],
    sinceMs: number,
  ): boolean {
    for (const tag of tags) {
      const at = this.tagInvalidatedAt.get(tag);
      // >= so a same-millisecond invalidation wins (freshness over staleness),
      // matching the CF marker comparison.
      if (at !== undefined && at >= sinceMs) return true;
    }
    return false;
  }

  async invalidateTags(tags: string[]): Promise<void> {
    const invalidatedAt = Date.now();
    for (const tag of tags) {
      // Marker first: build-shell entries evict by marker comparison even when
      // no runtime entry currently carries the tag (tagIndex miss below).
      this.tagInvalidatedAt.set(tag, invalidatedAt);
      const keys = this.tagIndex.get(tag);
      if (!keys || keys.size === 0) continue;

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
        } else if (prefix === "shell") {
          this.shellCache.delete(rawKey);
        }

        this.unregisterTags(prefixedKey);
      }
    }
  }

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

  getStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }

  static resetGlobalCache(): void {
    delete (globalThis as any)[CACHE_REGISTRY_KEY];
    delete (globalThis as any)[RESPONSE_CACHE_REGISTRY_KEY];
    delete (globalThis as any)[ITEM_CACHE_REGISTRY_KEY];
    delete (globalThis as any)[SHELL_CACHE_REGISTRY_KEY];
    delete (globalThis as any)[TAG_INDEX_REGISTRY_KEY];
    delete (globalThis as any)[KEY_TAGS_REGISTRY_KEY];
  }
}
