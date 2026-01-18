/**
 * RSC Handler Types
 *
 * Type definitions for the RSC request handler, payload structures,
 * and SSR integration.
 */

import type { ResolvedSegment, SlotState } from "../types.js";
import type { HandleData } from "../server/handle-store.js";
import type { RSCRouter } from "../router.js";

/**
 * RSC payload sent to the client
 */
export interface RscPayload {
  root: React.ReactNode | Promise<React.ReactNode>;
  metadata?: {
    pathname: string;
    segments: ResolvedSegment[];
    isPartial?: boolean;
    isError?: boolean;
    matched?: string[];
    diff?: string[];
    slots?: Record<string, SlotState>;
    /** Root layout component for browser-side re-renders (client component reference) */
    rootLayout?: React.ComponentType<{ children: React.ReactNode }>;
    /** Handle data accumulated across route segments (async generator that yields on each push) */
    handles?: AsyncGenerator<HandleData, void, unknown>;
    /** RSC version string for cache invalidation */
    version?: string;
  };
  returnValue?: { ok: boolean; data: unknown };
  formState?: unknown;
}

/**
 * React form state type for useActionState progressive enhancement
 */
export type ReactFormState = unknown;

/**
 * RSC dependencies from @vitejs/plugin-rsc/rsc
 */
export interface RSCDependencies {
  /**
   * renderToReadableStream from @vitejs/plugin-rsc/rsc
   */
  renderToReadableStream: <T>(
    payload: T,
    options?: { temporaryReferences?: unknown }
  ) => ReadableStream<Uint8Array>;

  /**
   * decodeReply from @vitejs/plugin-rsc/rsc
   */
  decodeReply: (
    body: FormData | string,
    options?: { temporaryReferences?: unknown }
  ) => Promise<unknown[]>;

  /**
   * createTemporaryReferenceSet from @vitejs/plugin-rsc/rsc
   */
  createTemporaryReferenceSet: () => unknown;

  /**
   * loadServerAction from @vitejs/plugin-rsc/rsc
   */
  loadServerAction: (actionId: string) => Promise<Function>;

  /**
   * decodeAction from @vitejs/plugin-rsc/rsc
   * Decodes a FormData into a bound action function (for useActionState forms)
   */
  decodeAction: (body: FormData) => Promise<() => Promise<unknown>>;

  /**
   * decodeFormState from @vitejs/plugin-rsc/rsc
   * Decodes the action result into a ReactFormState for useActionState progressive enhancement
   */
  decodeFormState: (
    actionResult: unknown,
    body: FormData
  ) => Promise<ReactFormState | null>;
}

/**
 * Options for SSR HTML rendering
 */
export interface SSRRenderOptions {
  /**
   * Form state for useActionState progressive enhancement.
   * This is the result of decodeFormState() and should be passed to
   * react-dom's renderToReadableStream to enable useActionState to
   * receive the action result during SSR.
   */
  formState?: ReactFormState | null;

  /**
   * Nonce for Content Security Policy (CSP)
   */
  nonce?: string;
}

/**
 * SSR module interface for HTML rendering
 */
export interface SSRModule {
  renderHTML: (
    rscStream: ReadableStream<Uint8Array>,
    options?: SSRRenderOptions
  ) => Promise<ReadableStream<Uint8Array>>;

  /**
   * Render RSC to HTML without RSC payload injection.
   * Used for shell caching.
   */
  renderShell?: (
    rscStream: ReadableStream<Uint8Array>,
    options?: SSRRenderOptions
  ) => Promise<ReadableStream<Uint8Array>>;

  /**
   * Inject RSC payload into HTML stream.
   */
  injectRSCPayload?: (
    rscStream: ReadableStream<Uint8Array>
  ) => TransformStream<Uint8Array, Uint8Array>;
}

/**
 * Configuration for HTML shell caching (PPR - Partial Pre-Rendering)
 *
 * When enabled, the HTML shell (layouts + Suspense fallbacks) is cached
 * independently from RSC data. On cache hit, the shell streams immediately
 * while fresh RSC payload is injected on every request.
 */
export interface PPRShellConfig {
  /**
   * Enable shell caching
   */
  enabled: boolean;

  /**
   * Cache store implementation.
   * If not provided, uses an internal in-memory store (dev/single-instance only).
   *
   * @example With custom store
   * ```typescript
   * shell: {
   *   enabled: true,
   *   store: new MemoryShellCacheStore({ defaults: { ttl: 60, swr: 300 } }),
   * }
   * ```
   */
  store?: import("../cache/shell-cache-store.js").ShellCacheStore;

  /**
   * Default TTL/SWR options when not specified via headers.
   * If store has defaults, these take precedence.
   */
  defaults?: {
    /** Default time-to-live in seconds (default: 60) */
    ttl?: number;
    /** Default stale-while-revalidate window in seconds (default: 0) */
    swr?: number;
  };

  /**
   * Custom cache key generator.
   * Takes precedence over store.getCacheKey() if provided.
   *
   * Use this to add segmentation based on:
   * - Language (Accept-Language header)
   * - User state (guest vs authenticated)
   * - A/B test buckets
   * - Query params that affect shell
   *
   * @example Include language in cache key
   * ```typescript
   * cacheKey: (ctx) => {
   *   const lang = ctx.request.headers.get("Accept-Language")?.split(",")[0] || "en";
   *   return `shell:${ctx.version}:${lang}:${ctx.pathname}`;
   * }
   * ```
   *
   * @example Include user segment from middleware
   * ```typescript
   * cacheKey: (ctx) => {
   *   const segment = ctx.variables.userSegment || "guest";
   *   return `shell:${ctx.version}:${segment}:${ctx.pathname}`;
   * }
   * ```
   */
  cacheKey?: (ctx: import("../cache/shell-cache-store.js").ShellCacheContext) => string;

  /**
   * Determine whether to cache the shell for this request.
   * If not provided, always caches when enabled.
   *
   * Use this to require opt-in via headers (e.g., from a CDN):
   *
   * @example Require header for caching
   * ```typescript
   * shouldCache: (ctx) => ctx.request.headers.has("x-enable-ppr")
   * ```
   *
   * @example Only cache for unauthenticated users
   * ```typescript
   * shouldCache: (ctx) => !ctx.request.headers.has("authorization")
   * ```
   */
  shouldCache?: (ctx: import("../cache/shell-cache-store.js").ShellCacheContext) => boolean;

  /**
   * Cache-Control header for cached shell responses (deprecated, use defaults.ttl instead)
   * @deprecated Use `defaults.ttl` instead
   */
  cacheControl?: string;
}

/**
 * Function to load SSR module dynamically
 */
export type LoadSSRModule = () => Promise<SSRModule>;

/**
 * Cache configuration for handler.
 * TTL is configured via store.defaults or cache() boundaries.
 */
export interface HandlerCacheConfig {
  /** Cache store implementation */
  store: import("../cache/types.js").SegmentCacheStore;
  /** Enable/disable caching (default: true) */
  enabled?: boolean;
}

/**
 * Nonce provider function type.
 * Can return a nonce string, or true to auto-generate one.
 */
export type NonceProvider<TEnv = unknown> = (
  request: Request,
  env: TEnv
) => string | true | Promise<string | true>;

/**
 * Options for creating an RSC handler
 */
export interface CreateRSCHandlerOptions<TEnv = unknown> {
  /**
   * The RSC router instance
   */
  router: RSCRouter<TEnv>;

  /**
   * RSC dependencies from @vitejs/plugin-rsc/rsc.
   * Defaults to the exports from @vitejs/plugin-rsc/rsc.
   */
  deps?: RSCDependencies;

  /**
   * Function to load the SSR module for HTML rendering.
   * Defaults to: () => import.meta.viteRsc.loadModule("ssr", "index")
   */
  loadSSRModule?: LoadSSRModule;

  /**
   * Cache configuration for segment caching.
   *
   * Can be a static config object or a function that receives the env
   * (useful for accessing Cloudflare bindings).
   *
   * If not provided, caching is disabled. TTL is configured via store.defaults
   * or cache() boundaries in the route definition.
   *
   * @example Static config
   * ```typescript
   * cache: {
   *   store: new MemorySegmentCacheStore({ defaults: { ttl: 60 } }),
   * }
   * ```
   *
   * @example Dynamic config with env
   * ```typescript
   * cache: (env) => ({
   *   store: new KVSegmentCacheStore(env.Bindings.MY_CACHE, { defaults: { ttl: 60 } }),
   * })
   * ```
   */
  cache?: HandlerCacheConfig | ((env: TEnv) => HandlerCacheConfig);

  /**
   * RSC version string included in metadata.
   * The browser sends this back on partial requests to detect version mismatches.
   *
   * Defaults to the auto-generated VERSION from `rsc-router:version` virtual module.
   * Only set this if you need a custom versioning strategy.
   *
   * @default VERSION from rsc-router:version
   */
  version?: string;

  /**
   * HTML shell caching configuration.
   *
   * When enabled, the first request to a route caches the HTML shell.
   * Subsequent requests return the cached shell immediately (fast TTFB)
   * and stream fresh RSC data for hydration.
   *
   * @example
   * ```typescript
   * export default createRSCHandler({
   *   router,
   *   shell: { enabled: true },
   * });
   * ```
   */
  shell?: PPRShellConfig | ((env: TEnv) => PPRShellConfig);

  /**
   * Nonce provider for Content Security Policy (CSP).
   *
   * Can be:
   * - A function that returns a nonce string
   * - A function that returns `true` to auto-generate a nonce
   * - Undefined to disable nonce (default)
   *
   * The nonce will be applied to inline scripts injected by the RSC payload.
   * It's also available to middleware via `ctx.get('nonce')`.
   *
   * @example Auto-generate nonce
   * ```tsx
   * createRSCHandler({
   *   router,
   *   nonce: () => true,
   * });
   * ```
   *
   * @example Custom nonce from request context
   * ```tsx
   * createRSCHandler({
   *   router,
   *   nonce: (request, env) => env.nonce,
   * });
   * ```
   */
  nonce?: NonceProvider<TEnv>;
}
