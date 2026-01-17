/**
 * Shell Cache Store Types
 *
 * Interface for caching HTML shells (Suspense fallbacks) with TTL and SWR support.
 * The shell is the static HTML structure without RSC data - it streams instantly
 * on cache hit while fresh RSC payload is injected on every request.
 */

// ============================================================================
// Shell Cache Context
// ============================================================================

/**
 * Context for shell cache key generation.
 * Provides all information needed to create cache keys with custom segmentation.
 */
export interface ShellCacheContext {
  /** The original request */
  request: Request;
  /** Parsed URL */
  url: URL;
  /** URL pathname (e.g., "/shop/product/123") */
  pathname: string;
  /** RSC version string for cache invalidation */
  version: string;
  /** Route params (e.g., { slug: "123" }) */
  params: Record<string, string>;
  /** Middleware variables (e.g., { user: {...}, abBucket: "A" }) */
  variables: Record<string, any>;
}

// ============================================================================
// Shell Cache Entry
// ============================================================================

/**
 * Cached shell entry data.
 */
export interface ShellCacheEntry {
  /** Cached HTML bytes (without RSC payload) */
  html: Uint8Array;
  /** Timestamp when entry was created (ms since epoch) */
  createdAt: number;
  /** Timestamp when entry becomes stale (ms since epoch, for SWR) */
  staleAt?: number;
}

/**
 * Result from cache get() with staleness info for SWR support.
 */
export interface ShellCacheResult {
  /** The cached entry */
  entry: ShellCacheEntry;
  /** Cache status: "fresh" if within TTL, "stale" if past TTL but within SWR window */
  status: "fresh" | "stale";
}

// ============================================================================
// Shell Cache Store Interface
// ============================================================================

/**
 * Shell cache store interface.
 *
 * Implementations handle storage of HTML shells with TTL and optional SWR support.
 * Shells are stored without RSC data and have fresh RSC injected on each request.
 *
 * @example Memory implementation (dev)
 * ```typescript
 * const store = new MemoryShellCacheStore({
 *   defaults: { ttl: 60, swr: 300 }
 * });
 * ```
 *
 * @example Custom cache key for i18n
 * ```typescript
 * class I18nShellCacheStore implements ShellCacheStore {
 *   getCacheKey(ctx: ShellCacheContext): string {
 *     const lang = ctx.request.headers.get("Accept-Language")?.split(",")[0] || "en";
 *     return `shell:${ctx.version}:${lang}:${ctx.pathname}`;
 *   }
 *   // ... rest of implementation
 * }
 * ```
 */
export interface ShellCacheStore {
  /**
   * Get cached shell entry by key.
   * @param key - Cache key
   * @returns Cache result with entry and staleness status, or null if not found/expired
   */
  get(key: string): Promise<ShellCacheResult | null>;

  /**
   * Store shell entry with TTL.
   * @param key - Cache key
   * @param entry - Shell entry data
   * @param ttl - Time-to-live in seconds
   * @param swr - Optional stale-while-revalidate window in seconds
   */
  set(key: string, entry: ShellCacheEntry, ttl: number, swr?: number): Promise<void>;

  /**
   * Delete cached shell.
   * @param key - Cache key
   * @returns true if deleted, false if not found
   */
  delete(key: string): Promise<boolean>;

  /**
   * Clear all cached shells (optional, for testing/dev).
   */
  clear?(): Promise<void>;

  /**
   * Optional: Generate cache key from context.
   * If implemented, this provides the default cache key for this store.
   * Can be overridden by `shell.cacheKey` in handler config.
   *
   * @param ctx - Shell cache context with request, params, variables, etc.
   * @returns Cache key string
   *
   * @example Include language in cache key
   * ```typescript
   * getCacheKey(ctx: ShellCacheContext): string {
   *   const lang = ctx.request.headers.get("Accept-Language")?.split(",")[0] || "en";
   *   return `shell:${ctx.version}:${lang}:${ctx.pathname}`;
   * }
   * ```
   */
  getCacheKey?(ctx: ShellCacheContext): string;

  /**
   * Default TTL/SWR options for this store.
   * Used when not specified in cache-control headers or handler config.
   */
  readonly defaults?: ShellCacheDefaults;
}

/**
 * Default cache options for shell store.
 */
export interface ShellCacheDefaults {
  /** Default time-to-live in seconds (default: 60) */
  ttl?: number;
  /** Default stale-while-revalidate window in seconds (default: 0) */
  swr?: number;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Generate default shell cache key.
 * Format: `shell:<version>:<pathname>`
 *
 * @param ctx - Shell cache context
 * @returns Default cache key
 */
export function defaultShellCacheKey(ctx: ShellCacheContext): string {
  return `shell:${ctx.version}:${ctx.pathname}`;
}

/**
 * Resolve shell cache key using priority order:
 * 1. Custom cacheKey function (from config)
 * 2. Store's getCacheKey method
 * 3. Default format
 *
 * @param ctx - Shell cache context
 * @param store - Optional shell cache store
 * @param customCacheKey - Optional custom cache key function
 * @returns Resolved cache key
 */
export function resolveShellCacheKey(
  ctx: ShellCacheContext,
  store?: ShellCacheStore,
  customCacheKey?: (ctx: ShellCacheContext) => string
): string {
  // Priority 1: Custom cacheKey function from config
  if (customCacheKey) {
    return customCacheKey(ctx);
  }
  // Priority 2: Store's getCacheKey method
  if (store?.getCacheKey) {
    return store.getCacheKey(ctx);
  }
  // Priority 3: Default format
  return defaultShellCacheKey(ctx);
}
