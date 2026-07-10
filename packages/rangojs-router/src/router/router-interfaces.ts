import type { ComponentType, ReactNode } from "react";
import type { SerializedManifest } from "../debug.js";
import type { ReverseFunction } from "../reverse.js";
import type { UrlPatterns } from "../urls.js";
import type { UrlBuilder, EnvCompatible } from "../urls/pattern-types.js";
import type { EntryData } from "../server/context";
import type { ErrorInfo, MatchResult } from "../types";
import type { NonceProvider } from "../rsc/types.js";
import type { ShellCaptureDebug } from "../rsc/shell-capture.js";
import type { ExecutionContext } from "../server/request-context.js";
import type { SerializedSegmentData } from "../cache/types.js";
import type { MiddlewareEntry, MiddlewareFn } from "./middleware.js";
import type { RouteMatchResult } from "./pattern-matching.js";
import type { ExtractParams } from "../types/route-config.js";
import { RSC_ROUTER_BRAND } from "./router-registry.js";
import type { RangoOptions, RootLayoutProps } from "./router-options.js";
import type { DefaultVars } from "../types/global-namespace.js";
import type { ResolvedTimeouts, OnTimeoutCallback } from "./timeout.js";
import type { ResolvedTracing } from "./tracing.js";
import type { TelemetrySink } from "./telemetry.js";

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
 * Public Rango router interface — the user-facing API surface.
 *
 * Users interact with this type when building and using routers.
 * Internal framework code uses RangoInternal (via toInternal()) to access
 * matching, build-time, and configuration members that are not part of the
 * public contract.
 *
 * TRoutes accumulates all registered route types through the builder chain.
 */
export interface Rango<
  TEnv = any,
  TRoutes extends Record<string, unknown> = Record<string, string>,
> {
  /**
   * Unique identifier for this router instance.
   * Used to namespace static output and isolate route maps between routers.
   */
  readonly id: string;

  /**
   * URL prefix applied to all routes. Undefined when no basename is configured.
   */
  readonly basename: string | undefined;

  /**
   * Register routes using URL patterns from urls() or a builder function
   *
   * @example
   * ```typescript
   * // With urls()
   * createRouter({}).routes(urlpatterns)
   *
   * // With builder function (urls() is implicit)
   * createRouter({}).routes(({ path, layout }) => [
   *   layout(RootLayout, () => [
   *     path("/", HomePage),
   *   ]),
   * ])
   * ```
   */
  routes<T extends UrlPatterns<any, any, any>>(
    patterns: T & EnvCompatible<T, TEnv>,
  ): Rango<
    TEnv,
    TRoutes &
      (NonNullable<T["_routes"]> extends Record<string, unknown>
        ? MergeRoutesWithResponses<NonNullable<T["_routes"]>, T["_responses"]>
        : Record<string, string>)
  >;
  routes(builder: UrlBuilder<TEnv>): Rango<TEnv, TRoutes>;

  /**
   * Add global middleware that runs on all routes
   *
   * @example
   * ```typescript
   * createRouter({ document: RootLayout })
   *   .use(loggerMiddleware)           // All routes
   *   .use("/api/*", rateLimiter)      // Pattern match
   *   .use("/users/:id", (ctx) => {})  // ctx.params.id is typed
   *   .routes(urlpatterns)
   * ```
   */
  use<Pattern extends string>(
    pattern: Pattern,
    middleware: MiddlewareFn<TEnv, ExtractParams<Pattern>>,
  ): Rango<TEnv, TRoutes>;
  use(
    patternOrMiddleware: string | MiddlewareFn<TEnv>,
    middleware?: MiddlewareFn<TEnv>,
  ): Rango<TEnv, TRoutes>;

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
   *   namespace Rango {
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
 * Internal Rango router interface — the full framework-facing API.
 *
 * This type includes all members used by the Vite plugin, RSC handler,
 * pre-rendering pipeline, and other framework internals. It is NOT exported
 * from the public package API.
 *
 * Use toInternal(router) to assert a public Rango into this type
 * at the boundary where framework code receives a user-provided router.
 */
export interface RangoInternal<
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

  /** URL prefix applied to all routes. */
  readonly basename: string | undefined;

  /**
   * Register routes using URL patterns from urls() or a builder function.
   *
   * Env compatibility is checked by EnvCompatible: an env-agnostic urls() block
   * (its env is `unknown` — e.g. a shared module, or an app that does not augment
   * `Rango.Env`) attaches to any router, while a urls<TEnv>() block carrying a
   * concrete env is accepted only when this router's `TEnv` satisfies it. So a
   * `urls<{ DB }>()` cannot be mounted on a `createRouter<{}>()`.
   */
  routes<T extends UrlPatterns<any, any, any>>(
    patterns: T & EnvCompatible<T, TEnv>,
  ): Rango<
    TEnv,
    TRoutes &
      (NonNullable<T["_routes"]> extends Record<string, unknown>
        ? MergeRoutesWithResponses<NonNullable<T["_routes"]>, T["_responses"]>
        : Record<string, string>)
  >;
  routes(builder: UrlBuilder<TEnv>): Rango<TEnv, TRoutes>;

  /**
   * Add global middleware that runs on all routes
   */
  use<Pattern extends string>(
    pattern: Pattern,
    middleware: MiddlewareFn<TEnv, ExtractParams<Pattern>>,
  ): Rango<TEnv, TRoutes>;
  use(
    patternOrMiddleware: string | MiddlewareFn<TEnv>,
    middleware?: MiddlewareFn<TEnv>,
  ): Rango<TEnv, TRoutes>;

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
  readonly onError?: RangoOptions<TEnv>["onError"];

  /**
   * Cache configuration
   */
  readonly cache?: RangoOptions<TEnv>["cache"];

  /**
   * Not found component to render when no route matches
   */
  readonly notFound?: RangoOptions<TEnv>["notFound"];

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
   * Maximum number of decoded prefetch payloads the client keeps in its
   * in-memory prefetch cache (FIFO eviction at capacity). Shipped to the
   * client in payload metadata. Derived from prefetchCacheSize.
   */
  readonly prefetchCacheSize: number;

  /**
   * Maximum number of speculative prefetch requests the client runs
   * concurrently. Shipped to the client in payload metadata. Derived from
   * prefetchConcurrency.
   */
  readonly prefetchConcurrency: number;

  /**
   * Resolved rango state cookie name (`{prefix}_{routerId}`), composed once at
   * router init and shipped to the client in payload metadata. The server-side
   * cookie writer reads it from here; the client reads it from metadata.
   */
  readonly resolvedStateCookieName: string;

  /**
   * Whether connection warmup is enabled.
   * When true, the client sends HEAD /?_rsc_warmup after idle periods
   * and the server responds with 204 No Content.
   */
  readonly warmupEnabled: boolean;

  /**
   * Whether the client hydrates inside React.StrictMode. Resolved from
   * createRouter({ strictMode }) (default true) and shipped to the client in
   * the initial payload metadata.
   */
  readonly strictMode: boolean;

  /**
   * Whether router-wide performance debugging is enabled.
   * Used by the request handler to create metrics before middleware runs.
   */
  readonly debugPerformance?: boolean;

  /**
   * PPR shell-capture debug sink (createRouter({ debugShellCapture })), read
   * by rsc-rendering when it builds the capture descriptor for a ppr route.
   */
  readonly debugShellCapture?: ShellCaptureDebug;

  /**
   * Resolved platform phase-span tracing (Cloudflare custom spans or OTel), or
   * undefined when off. Threaded onto the request context and read at each
   * traced phase.
   */
  readonly tracing?: ResolvedTracing;

  /**
   * Raw telemetry sink from RangoOptions, exposed so handler-level emitters
   * (rsc/handler.ts timeout/origin/late-handle) can emit WITHOUT the
   * RouterContext ALS, which only match()/matchPartial() enter. See
   * observeEvent's emitter list in router/instrument.ts.
   */
  readonly telemetry?: TelemetrySink;

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

  /** @internal basename for runtime manifest generation */
  readonly __basename?: string;

  /** @internal Cloudflare dev worker generation captured at construction. */
  readonly __devDiscoveryEpoch?: number;

  /**
   * @internal Router-level error/notFound fallbacks (`createRouter` options),
   * exposed for the build-time clientChunks discovery so a `"use client"`
   * default boundary is routed into the dedicated `app-fallback` chunk. Unlike
   * the route-tree `errorBoundary()`/`notFoundBoundary()` helpers these never
   * land in `EntryData`, so they are read directly off the router instance.
   */
  readonly __defaultErrorBoundary?: RangoOptions<TEnv>["defaultErrorBoundary"];
  readonly __defaultNotFoundBoundary?: RangoOptions<TEnv>["defaultNotFoundBoundary"];
  readonly __notFound?: RangoOptions<TEnv>["notFound"];

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
    buildEnv?: any,
    devMode?: boolean,
  ): Promise<{
    segments: SerializedSegmentData[];
    /** RSC-encoded handle map ("" when none) — see handle-snapshot.ts. */
    handles: string;
    routeName: string;
    params: Record<string, string>;
    interceptSegments?: SerializedSegmentData[];
    /** RSC-encoded MERGED (main + intercept) handle map for the intercept artifact. */
    interceptHandles?: string;
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
    buildEnv?: any,
    devMode?: boolean,
  ): Promise<{ encoded: string; handles: string } | null>;

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
   * Low-level route matching function.
   * Used by classifyRequest() for request classification without
   * entering the full match pipeline.
   */
  // Async since a lazy async include (`() => import()`) must resolve before its
  // routes can match. Typed (not `any`) so a consumer doing
  // `const m = router.findMatch(p); if (!m) ...; m.entry` gets a compile error
  // (m is a Promise) instead of the silent always-truthy bug.
  findMatch(
    pathname: string,
    metricsStore?: any,
  ): Promise<RouteMatchResult<TEnv> | null>;

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
 * Assert a public Rango into the internal type.
 *
 * Use this at the boundary where framework code receives a user-provided
 * router and needs access to internal members (match, config, build-time).
 * The cast is safe because createRouter() always produces an object that
 * satisfies RangoInternal; the public type is just a narrower view.
 */
export function toInternal<
  TEnv = any,
  TRoutes extends Record<string, unknown> = Record<string, string>,
>(router: Rango<TEnv, TRoutes>): RangoInternal<TEnv, TRoutes> {
  return router as RangoInternal<TEnv, TRoutes>;
}
