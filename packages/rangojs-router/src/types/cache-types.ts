/**
 * Context passed to cache condition/key/tags functions.
 *
 * This is a subset of RequestContext that's guaranteed to be available
 * during cache key generation (before middleware runs).
 *
 * Note: While the full RequestContext is passed, middleware-set variables
 * read via `ctx.get()` may not be populated yet since cache lookup happens
 * before middleware execution.
 */
export type { RequestContext as CacheContext } from "../server/request-context.js";

/**
 * Cache configuration options for cache() DSL
 *
 * Controls how segments, layouts, and loaders are cached.
 * Cache configuration inherits down the route tree unless overridden.
 *
 * @example
 * ```typescript
 * // Basic caching with TTL
 * cache({ ttl: 60 }, () => [
 *   layout(<BlogLayout />),
 *   route("post/:slug"),
 * ])
 *
 * // With stale-while-revalidate
 * cache({ ttl: 60, swr: 300 }, () => [
 *   route("product/:id"),
 * ])
 *
 * // Conditional caching
 * cache({
 *   ttl: 300,
 *   condition: (ctx) => !ctx.request.headers.get('x-preview'),
 * }, () => [...])
 *
 * // Custom cache key
 * cache({
 *   ttl: 300,
 *   key: (ctx) => `product-${ctx.params.id}-${ctx.searchParams.get('variant')}`,
 * }, () => [...])
 *
 * // With tags for invalidation
 * cache({
 *   ttl: 300,
 *   tags: (ctx) => [`product:${ctx.params.id}`, 'products'],
 * }, () => [...])
 * ```
 */
export interface CacheOptions<TEnv = unknown> {
  /**
   * Time-to-live in seconds.
   * After this period, cached content is considered stale.
   */
  ttl: number;

  /**
   * Stale-while-revalidate window in seconds (after TTL).
   * During this window, stale content is served immediately while
   * fresh content is fetched in the background via waitUntil.
   *
   * @example
   * // TTL: 60s, SWR: 300s
   * // 0-60s: FRESH (serve from cache)
   * // 60-360s: STALE (serve from cache, revalidate in background)
   * // 360s+: EXPIRED (cache miss, fetch fresh)
   */
  swr?: number;

  /**
   * Override the cache store for this boundary.
   * When specified, this boundary and its children use this store
   * instead of the app-level store from handler config.
   *
   * Useful for:
   * - Different backends per route section (memory vs KV vs Redis)
   * - Loader-specific caching strategies
   * - Hot data in fast cache, cold data in larger/slower cache
   *
   * @example
   * ```typescript
   * const kvStore = new CloudflareKVStore(env.CACHE_KV);
   * const memoryStore = new MemorySegmentCacheStore({ defaults: { ttl: 10 } });
   *
   * // Fast memory cache for hot data
   * cache({ store: memoryStore }, () => [
   *   route("dashboard"),
   * ])
   *
   * // KV for larger, less frequently accessed data
   * cache({ store: kvStore, ttl: 3600 }, () => [
   *   route("archive/:year"),
   * ])
   * ```
   */
  store?: import("../cache/types.js").SegmentCacheStore;

  /**
   * Conditional cache read function.
   * Return false to skip cache for this request (always fetch fresh).
   *
   * Has access to full RequestContext including env, request, params, cookies, etc.
   * Note: Middleware-set variables read via `ctx.get()` may not be populated yet.
   *
   * @example
   * ```typescript
   * condition: (ctx) => {
   *   // Skip cache for preview mode
   *   if (ctx.request.headers.get('x-preview')) return false;
   *   // Skip cache for authenticated users
   *   if (ctx.request.headers.has('authorization')) return false;
   *   return true;
   * }
   * ```
   */
  condition?: (
    ctx: import("../server/request-context.js").RequestContext<TEnv>,
  ) => boolean;

  /**
   * Custom cache key function - FULL OVERRIDE.
   * Bypasses default key generation AND store's keyGenerator.
   *
   * Has access to full RequestContext including env, request, params, cookies, etc.
   * Note: Middleware-set variables read via `ctx.get()` may not be populated yet.
   *
   * @example
   * ```typescript
   * // Include query params in cache key
   * key: (ctx) => `product-${ctx.params.id}-${ctx.searchParams.get('variant')}`
   *
   * // Include env bindings
   * key: (ctx) => `${ctx.env.REGION}:product:${ctx.params.id}`
   *
   * // Include cookies
   * key: (ctx) => `${cookies().get('locale')?.value ?? 'en'}:${ctx.pathname}`
   * ```
   */
  key?: (
    ctx: import("../server/request-context.js").RequestContext<TEnv>,
  ) => string | Promise<string>;

  /**
   * Tags for cache invalidation.
   * Can be a static array or a function that returns tags.
   *
   * Note: Tags are passed through to the store but built-in stores
   * (MemorySegmentCacheStore, CFCacheStore) do not yet index or
   * invalidate by tag. Effective tag-based invalidation requires a
   * custom store implementation with secondary indices.
   *
   * @example
   * ```typescript
   * // Static tags
   * tags: ['products', 'catalog']
   *
   * // Dynamic tags
   * tags: (ctx) => [`product:${ctx.params.id}`, 'products']
   * ```
   */
  tags?:
    | string[]
    | ((
        ctx: import("../server/request-context.js").RequestContext<TEnv>,
      ) => string[]);
}

/**
 * Partial cache options for cache() DSL.
 *
 * When `ttl` is not specified, it will use the default from cache config.
 * This allows cache() calls to inherit app-level defaults:
 *
 * @example
 * ```typescript
 * // App-level default (in handler config)
 * cache: { store: myStore, defaults: { ttl: 60 } }
 *
 * // Route-level (inherits ttl from defaults)
 * cache(() => [
 *   route("products"),
 * ])
 *
 * // Override with explicit ttl
 * cache({ ttl: 300 }, () => [...])
 * ```
 */
export type PartialCacheOptions<TEnv = unknown> = Partial<CacheOptions<TEnv>>;

/**
 * Cache entry configuration stored in EntryData.
 * Represents the resolved cache config for a segment.
 */
export interface EntryCacheConfig {
  /** Cache options (false means caching disabled for this entry) - ttl is optional, uses defaults */
  options: PartialCacheOptions | false;
}
