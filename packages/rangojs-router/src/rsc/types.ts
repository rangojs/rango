/**
 * RSC Handler Types
 *
 * Type definitions for the RSC request handler, payload structures,
 * and SSR integration.
 */

import type { ResolvedSegment, SlotState } from "../types.js";
import type { HandleData } from "../server/handle-store.js";
import type { RSCRouterInternal } from "../router/router-interfaces.js";
import type { ResolvedThemeConfig, Theme } from "../theme/types.js";

/**
 * RSC payload sent to the client.
 * The tree is always reconstructed from metadata.segments by consumers
 * (SSR via renderSegments, browser via renderSegments in bridges).
 */
export interface RscPayload {
  metadata?: {
    pathname: string;
    segments: ResolvedSegment[];
    isPartial?: boolean;
    isError?: boolean;
    matched?: string[];
    diff?: string[];
    /** Merged route params from the matched route */
    params?: Record<string, string>;
    slots?: Record<string, SlotState>;
    /** Root layout component for browser-side re-renders (client component reference) */
    rootLayout?: React.ComponentType<{ children: React.ReactNode }>;
    /** Handle data accumulated across route segments (async generator that yields on each push) */
    handles?: AsyncGenerator<HandleData, void, unknown>;
    /** RSC version string for cache invalidation */
    version?: string;
    /** Theme configuration for FOUC prevention */
    themeConfig?: ResolvedThemeConfig | null;
    /** Initial theme from cookie (for SSR hydration) */
    initialTheme?: Theme;
    /** Whether connection warmup is enabled */
    warmupEnabled?: boolean;
    /** Server-side redirect with optional state (for partial requests) */
    redirect?: { url: string };
    /** Server-set location state to include in history.pushState */
    locationState?: Record<string, unknown>;
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
    options?: { temporaryReferences?: unknown },
  ) => ReadableStream<Uint8Array>;

  /**
   * decodeReply from @vitejs/plugin-rsc/rsc
   */
  decodeReply: (
    body: FormData | string,
    options?: { temporaryReferences?: unknown },
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
    body: FormData,
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
    options?: SSRRenderOptions,
  ) => Promise<ReadableStream<Uint8Array>>;
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
  env: TEnv,
) => string | true | Promise<string | true>;

/**
 * Options for creating an RSC handler
 */
export interface CreateRSCHandlerOptions<
  TEnv = unknown,
  TRoutes extends Record<string, string> = Record<string, string>,
> {
  /**
   * The RSC router instance
   */
  router: RSCRouterInternal<TEnv, TRoutes>;

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
   * Nonce provider for Content Security Policy (CSP).
   *
   * Can be:
   * - A function that returns a nonce string
   * - A function that returns `true` to auto-generate a nonce
   * - Undefined to disable nonce (default)
   *
   * The nonce will be applied to inline scripts injected by the RSC payload.
   * It's also available to middleware via the typed `nonce` token:
   * `import { nonce } from "@rangojs/router"; ctx.get(nonce)`
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
   *
   * @example Access nonce in middleware
   * ```tsx
   * import { nonce } from "@rangojs/router";
   *
   * const cspMiddleware: Middleware = async (ctx, next) => {
   *   const value = ctx.get(nonce); // string | undefined
   *   await next();
   * };
   * ```
   */
  nonce?: NonceProvider<TEnv>;
}
