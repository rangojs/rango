import type { ComponentType, ReactNode } from "react";
import type { SerializedManifest } from "../debug.js";
import type { ReverseFunction } from "../reverse.js";
import type { UrlPatterns } from "../urls.js";
import type { EntryData } from "../server/context";
import type { ErrorInfo, MatchResult } from "../types";
import type { NonceProvider } from "../rsc/types.js";
import type { ExecutionContext } from "../server/request-context.js";
import type {
  SerializedSegmentData,
  SegmentHandleData,
} from "../cache/types.js";
import type { MiddlewareEntry, MiddlewareFn } from "./middleware.js";
import { RSC_ROUTER_BRAND } from "./router-registry.js";
import type { RSCRouterOptions, RootLayoutProps } from "./router-options.js";
import type { DefaultVars } from "../types/global-namespace.js";
import type { ResolvedTimeouts, OnTimeoutCallback } from "./timeout.js";

/**
 * Options passed to router.fetch(), router.match(), and other request entrypoints.
 * All entrypoints use this same shape for consistency.
 */
export interface RouterRequestInput<TEnv, TVars = DefaultVars> {
  env?: TEnv;
  vars?: Partial<TVars>;
  ctx?: ExecutionContext;
}

/**
 * Merge route patterns with response types into a single route map.
 * Routes with response types get { path, response } objects; others stay as strings.
 * Handles both plain string routes and { path, search } object routes.
 */
type MergeRoutesWithResponses<
  TRoutes extends Record<string, unknown>,
  TResponses,
> = {
  [K in keyof TRoutes]: K extends keyof NonNullable<TResponses>
    ? unknown extends NonNullable<TResponses>[K]
      ? TRoutes[K] // RSC route — TData defaults to unknown, keep as-is
      : TRoutes[K] extends { readonly path: infer P extends string }
        ? TRoutes[K] & { readonly response: NonNullable<TResponses>[K] }
        : {
            readonly path: TRoutes[K] & string;
            readonly response: NonNullable<TResponses>[K];
          }
    : TRoutes[K];
};

/**
 * Public RSC Router interface — the user-facing API surface.
 *
 * Users interact with this type when building and using routers.
 * Internal framework code uses RSCRouterInternal (via toInternal()) to access
 * matching, build-time, and configuration members that are not part of the
 * public contract.
 *
 * TRoutes accumulates all registered route types through the builder chain.
 */
export interface RSCRouter<
  TEnv = any,
  TRoutes extends Record<string, unknown> = Record<string, string>,
> {
  /**
   * Unique identifier for this router instance.
   * Used to namespace static output and isolate route maps between routers.
   */
  readonly id: string;

  /**
   * Register routes using URL patterns from urls()
   *
   * @example
   * ```typescript
   * createRouter({})
   *   .routes(urlpatterns)
   * ```
   */
  routes<T extends UrlPatterns<TEnv, any>>(
    patterns: T,
  ): RSCRouter<
    TEnv,
    TRoutes &
      (NonNullable<T["_routes"]> extends Record<string, unknown>
        ? MergeRoutesWithResponses<NonNullable<T["_routes"]>, T["_responses"]>
        : Record<string, string>)
  >;

  /**
   * Add global middleware that runs on all routes
   *
   * @example
   * ```typescript
   * createRouter({ document: RootLayout })
   *   .use(loggerMiddleware)           // All routes
   *   .use("/api/*", rateLimiter)      // Pattern match
   *   .routes(urlpatterns)
   * ```
   */
  use(
    patternOrMiddleware: string | MiddlewareFn<TEnv>,
    middleware?: MiddlewareFn<TEnv>,
  ): RSCRouter<TEnv, TRoutes>;

  /**
   * Type-safe URL builder for registered routes
   * Types are inferred from the accumulated route registrations
   *
   * @example
   * ```typescript
   * router.reverse("cart"); // "/shop/cart"
   * router.reverse("detail", { slug: "widget" }); // "/shop/product/widget"
   * ```
   */
  reverse: ReverseFunction<TRoutes>;

  /**
   * Accumulated route map for typeof extraction
   * Used for module augmentation: `type AppRoutes = typeof _router.routeMap`
   *
   * @example
   * ```typescript
   * const _router = createRouter<AppEnv>({
   *   urls: urlpatterns,
   * });
   *
   * type AppRoutes = typeof _router.routeMap;
   *
   * declare global {
   *   namespace RSCRouter {
   *     interface RegisteredRoutes extends AppRoutes {}
   *   }
   * }
   * ```
   */
  readonly routeMap: TRoutes;

  /**
   * Handle an RSC request.
   *
   * Uses the router's configuration (nonce, version, cache) automatically.
   * The handler is lazily created on first call.
   *
   * @example Cloudflare Workers
   * ```tsx
   * import { router } from "./router";
   *
   * export default { fetch: router.fetch };
   * ```
   *
   * @example Direct export
   * ```tsx
   * const router = createRouter({
   *   document: Document,
   *   urls: urlpatterns,
   *   nonce: () => true,
   * });
   *
   * export const fetch = router.fetch;
   * ```
   */
  fetch(request: Request, input?: RouterRequestInput<TEnv>): Promise<Response>;
}

/**
 * Internal RSC Router interface — the full framework-facing API.
 *
 * This type includes all members used by the Vite plugin, RSC handler,
 * pre-rendering pipeline, and other framework internals. It is NOT exported
 * from the public package API.
 *
 * Use toInternal(router) to assert a public RSCRouter into this type
 * at the boundary where framework code receives a user-provided router.
 */
export interface RSCRouterInternal<
  TEnv = any,
  TRoutes extends Record<string, unknown> = Record<string, string>,
> {
  /**
   * Brand marker for build-time discovery.
   * The Vite plugin uses this to identify router instances in module exports.
   */
  readonly __brand: typeof RSC_ROUTER_BRAND;

  /**
   * Unique identifier for this router instance.
   * Used to namespace static output and isolate route maps between routers.
   */
  readonly id: string;

  /**
   * Register routes using URL patterns from urls()
   */
  routes<T extends UrlPatterns<TEnv, any>>(
    patterns: T,
  ): RSCRouter<
    TEnv,
    TRoutes &
      (NonNullable<T["_routes"]> extends Record<string, unknown>
        ? MergeRoutesWithResponses<NonNullable<T["_routes"]>, T["_responses"]>
        : Record<string, string>)
  >;

  /**
   * Add global middleware that runs on all routes
   */
  use(
    patternOrMiddleware: string | MiddlewareFn<TEnv>,
    middleware?: MiddlewareFn<TEnv>,
  ): RSCRouter<TEnv, TRoutes>;

  /**
   * Type-safe URL builder for registered routes
   */
  reverse: ReverseFunction<TRoutes>;

  /**
   * Accumulated route map for typeof extraction
   */
  readonly routeMap: TRoutes;

  /**
   * Root layout component that wraps the entire application
   * Access this to pass to renderSegments
   */
  readonly rootLayout?: ComponentType<RootLayoutProps>;

  /**
   * Error callback for monitoring/alerting
   * Called when errors occur in loaders, actions, or routes
   */
  readonly onError?: RSCRouterOptions<TEnv>["onError"];

  /**
   * Cache configuration
   */
  readonly cache?: RSCRouterOptions<TEnv>["cache"];

  /**
   * Not found component to render when no route matches
   */
  readonly notFound?: RSCRouterOptions<TEnv>["notFound"];

  /**
   * Resolved theme configuration (null if theme not enabled)
   * Used by NavigationProvider to include ThemeProvider and by MetaTags to render theme script
   */
  readonly themeConfig: import("../theme/types.js").ResolvedThemeConfig | null;

  /**
   * Cache profiles for "use cache" per-request resolution.
   * Always includes at least the "default" profile.
   */
  readonly cacheProfiles: Record<
    string,
    import("../cache/profile-registry.js").CacheProfile
  >;

  /**
   * Cache-Control header value for prefetch responses.
   * False means no caching of prefetch responses.
   * Derived from prefetchCacheTTL.
   */
  readonly prefetchCacheControl: string | false;

  /**
   * TTL in milliseconds for the client-side in-memory prefetch cache.
   * 0 means caching is disabled.
   */
  readonly prefetchCacheTTL: number;

  /**
   * Whether connection warmup is enabled.
   * When true, the client sends HEAD /?_rsc_warmup after idle periods
   * and the server responds with 204 No Content.
   */
  readonly warmupEnabled: boolean;

  /**
   * Whether router-wide performance debugging is enabled.
   * Used by the request handler to create metrics before middleware runs.
   */
  readonly debugPerformance?: boolean;

  /**
   * Whether ?__debug_manifest is allowed in production.
   * Always enabled in development.
   */
  readonly allowDebugManifest: boolean;

  /**
   * Resolved timeout configuration (merged from shorthand + structured).
   */
  readonly timeouts: ResolvedTimeouts;

  /**
   * Custom timeout response handler.
   */
  readonly onTimeout?: OnTimeoutCallback<TEnv>;

  /**
   * App-level middleware entries
   * These wrap the entire request/response cycle
   */
  readonly middleware: MiddlewareEntry<TEnv>[];

  /**
   * Nonce provider for CSP
   */
  readonly nonce?: NonceProvider<TEnv>;

  /**
   * RSC version string
   */
  readonly version?: string;

  /**
   * URL patterns reference for build-time manifest generation
   */
  readonly urlpatterns?: UrlPatterns<TEnv, any>;

  /**
   * SSR configuration. resolveStreaming determines stream vs allReady
   * per HTML request (undefined = always stream).
   */
  readonly ssr?: import("./router-options.js").SSROptions<TEnv>;

  /**
   * Cross-origin request protection configuration.
   * Default: true (enabled).
   */
  readonly originCheck: import("../rsc/origin-guard.js").OriginCheckConfig<TEnv>;

  /**
   * Source file path where createRouter() was called.
   * Set via Error.stack parsing at construction time.
   * Used by the Vite plugin to write per-router named-routes.gen.ts files.
   */
  readonly __sourceFile?: string;

  match(
    request: Request,
    input?: RouterRequestInput<TEnv>,
  ): Promise<MatchResult>;

  /**
   * Build-time pre-render match. Resolves segments with a BuildContext
   * (no request/env/headers/cookies), skipping middleware and loaders.
   * Used by the Vite plugin to collect pre-render data at build time.
   */
  matchForPrerender(
    pathname: string,
    params: Record<string, string>,
    buildVars?: Record<string, any>,
    isPassthroughRoute?: boolean,
  ): Promise<{
    segments: SerializedSegmentData[];
    handles: Record<string, SegmentHandleData>;
    routeName: string;
    params: Record<string, string>;
    interceptSegments?: SerializedSegmentData[];
    interceptHandles?: Record<string, SegmentHandleData>;
    passthrough?: true;
  } | null>;

  /**
   * Render a single Static handler at build time.
   * Returns the RSC-serialized component string and handle data, or null on failure.
   */
  renderStaticSegment(
    handler: Function,
    handlerId: string,
    routeName?: string,
  ): Promise<{ encoded: string; handles: Record<string, unknown[]> } | null>;

  /**
   * Preview match - returns route middleware without segment resolution.
   * Also returns responseType and handler for response routes (non-RSC short-circuit).
   */
  previewMatch(
    request: Request,
    input?: RouterRequestInput<TEnv>,
  ): Promise<{
    routeMiddleware?: Array<{
      handler: import("./middleware.js").MiddlewareFn;
      params: Record<string, string>;
    }>;
    responseType?: string;
    handler?: Function;
    params?: Record<string, string>;
    negotiated?: boolean;
    manifestEntry?: EntryData;
    routeKey?: string;
  } | null>;

  matchPartial(
    request: Request,
    input?: RouterRequestInput<TEnv>,
    actionContext?: {
      actionId?: string;
      actionUrl?: URL;
      actionResult?: any;
      formData?: FormData;
    },
  ): Promise<MatchResult | null>;

  /**
   * Match an error to the nearest error boundary and return error segments
   *
   * Used when an action or other operation fails and we need to render
   * the error boundary UI. Finds the nearest errorBoundary in the route tree
   * for the current URL and renders it with the error info.
   *
   * @param request - The current request (used to match the route)
   * @param context - Environment context
   * @param error - The error that occurred
   * @param segmentType - Type of segment where error occurred (default: "route")
   * @returns MatchResult with error segment, or null if no error boundary found
   */
  matchError(
    request: Request,
    input: RouterRequestInput<TEnv> | undefined,
    error: unknown,
    segmentType?: ErrorInfo["segmentType"],
  ): Promise<MatchResult | null>;

  /**
   * Debug utility to serialize the manifest for inspection
   * Returns a JSON-friendly representation of all routes and layouts
   */
  debugManifest(): Promise<SerializedManifest>;

  /**
   * Handle an RSC request.
   */
  fetch(request: Request, input?: RouterRequestInput<TEnv>): Promise<Response>;
}

/**
 * Assert a public RSCRouter into the internal type.
 *
 * Use this at the boundary where framework code receives a user-provided
 * router and needs access to internal members (match, config, build-time).
 * The cast is safe because createRouter() always produces an object that
 * satisfies RSCRouterInternal; the public type is just a narrower view.
 */
export function toInternal<
  TEnv = any,
  TRoutes extends Record<string, unknown> = Record<string, string>,
>(router: RSCRouter<TEnv, TRoutes>): RSCRouterInternal<TEnv, TRoutes> {
  return router as RSCRouterInternal<TEnv, TRoutes>;
}
