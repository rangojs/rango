import type { ComponentType, ReactNode } from "react";
import type { SerializedManifest } from "../debug.js";
import type { PrefixRoutePatterns, ReverseFunction } from "../reverse.js";
import type { AllUseItems } from "../route-types.js";
import type { RouteHandlers } from "../route-definition.js";
import type { UrlPatterns } from "../urls.js";
import type { EntryData } from "../server/context";
import type {
  ErrorInfo,
  HandlerContext,
  MatchResult,
  RouteDefinition,
} from "../types";
import type { NonceProvider } from "../rsc/types.js";
import type { ExecutionContext } from "../server/request-context.js";
import type {
  SerializedSegmentData,
  SegmentHandleData,
} from "../cache/types.js";
import type { MiddlewareEntry, MiddlewareFn } from "./middleware.js";
import { RSC_ROUTER_BRAND } from "./router-registry.js";
import type { RSCRouterOptions, RootLayoutProps } from "./router-options.js";

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
 * Extract the URL pattern from a route entry (string or { path, response } object)
 */
type PatternOfEntry<V> = V extends string
  ? V
  : V extends { readonly path: infer P extends string }
    ? P
    : never;

/**
 * Type-level detection of conflicting route keys.
 * Extracts keys that exist in both TExisting and TNew but with different URL patterns.
 * Returns `never` if no conflicts exist.
 * Compares patterns (not full entries) to handle both string and { path, response } values.
 *
 * @example
 * ```typescript
 * ConflictingKeys<{ a: "/a" }, { a: "/b" }> // "a" (conflict - same key, different URLs)
 * ConflictingKeys<{ a: "/a" }, { a: "/a" }> // never (no conflict - same key and URL)
 * ConflictingKeys<{ a: "/a" }, { b: "/b" }> // never (no conflict - different keys)
 * ```
 */
type ConflictingKeys<
  TExisting extends Record<string, unknown>,
  TNew extends Record<string, unknown>,
> = {
  [K in keyof TExisting & keyof TNew]: PatternOfEntry<
    TExisting[K]
  > extends PatternOfEntry<TNew[K]>
    ? PatternOfEntry<TNew[K]> extends PatternOfEntry<TExisting[K]>
      ? never // Same pattern, no conflict
      : K // Different patterns, conflict
    : K; // Different patterns, conflict
}[keyof TExisting & keyof TNew];

/**
 * Error type returned when route keys conflict.
 * Methods require an impossible `never` parameter so TypeScript errors at the call site.
 */
type RouteConflictError<TConflicts extends string> = {
  __error: `Route key conflict! Key "${TConflicts}" already exists with a different URL pattern.`;
  hint: "Route keys must be globally unique. Use prefixed names like 'blog.index' instead of 'index'.";
  conflictingKeys: TConflicts;
  // These methods require `never` so calling them produces an error at the call site
  routes: (
    __conflict: `Fix route key conflict: "${TConflicts}" is already defined with a different URL pattern`,
  ) => never;
  map: (
    __conflict: `Fix route key conflict: "${TConflicts}" is already defined with a different URL pattern`,
  ) => never;
};

/**
 * Simplified route helpers for inline route definitions.
 * Uses TRoutes (Record<string, string>) instead of RouteDefinition.
 *
 * Note: Some helpers use `any` for context types as a trade-off for simpler usage.
 * The main type safety is in the `route` helper which enforces valid route names.
 * For full type safety, use the standard map() API with separate handler files.
 */
export type InlineRouteHelpers<TRoutes extends Record<string, string>, TEnv> = {
  /**
   * Define a route handler for a specific route pattern
   */
  route: <K extends keyof TRoutes & string>(
    name: K,
    handler:
      | ((ctx: HandlerContext<{}, TEnv>) => ReactNode | Promise<ReactNode>)
      | ReactNode,
  ) => AllUseItems;

  /**
   * Define a layout that wraps child routes
   */
  layout: (
    component:
      | ReactNode
      | ((ctx: HandlerContext<any, TEnv>) => ReactNode | Promise<ReactNode>),
    use?: () => AllUseItems[],
  ) => AllUseItems;

  /**
   * Define parallel routes
   */
  parallel: (
    slots: Record<
      `@${string}`,
      | ReactNode
      | ((ctx: HandlerContext<any, TEnv>) => ReactNode | Promise<ReactNode>)
    >,
    use?: () => AllUseItems[],
  ) => AllUseItems;

  /**
   * Define route middleware
   */
  middleware: (
    fn: (ctx: any, next: () => Promise<void>) => Promise<void>,
  ) => AllUseItems;

  /**
   * Define revalidation handlers
   */
  revalidate: (fn: (ctx: any) => boolean | Promise<boolean>) => AllUseItems;

  /**
   * Define data loaders
   */
  loader: (loader: any, use?: () => AllUseItems[]) => AllUseItems;

  /**
   * Define loading states
   */
  loading: (component: ReactNode) => AllUseItems;

  /**
   * Define error boundaries
   */
  errorBoundary: (
    handler: ReactNode | ((props: { error: Error }) => ReactNode),
  ) => AllUseItems;

  /**
   * Define not found boundaries
   */
  notFoundBoundary: (
    handler: ReactNode | ((props: { pathname: string }) => ReactNode),
  ) => AllUseItems;

  /**
   * Define intercept routes
   */
  intercept: (
    name: string,
    handler:
      | ReactNode
      | ((ctx: HandlerContext<any, TEnv>) => ReactNode | Promise<ReactNode>),
    use?: () => AllUseItems[],
  ) => AllUseItems;

  /**
   * Define when conditions for intercepts
   */
  when: (condition: (ctx: any) => boolean | Promise<boolean>) => AllUseItems;

  /**
   * Define cache configuration
   */
  cache: (
    config: { ttl?: number; swr?: number } | false,
    use?: () => AllUseItems[],
  ) => AllUseItems;
};

/**
 * Router builder for chaining .use() and .map()
 * TRoutes accumulates all registered route types through the chain
 * TLocalRoutes contains the routes for the current .routes() call (for inline handler typing)
 */
export interface RouteBuilder<
  T extends RouteDefinition,
  TEnv,
  TRoutes extends Record<string, unknown>,
  TLocalRoutes extends Record<string, string> = Record<string, string>,
> {
  /**
   * Add middleware scoped to this mount
   * Called between .routes() and .map()
   *
   * @example
   * ```typescript
   * .routes("/admin", adminRoutes)
   * .use(authMiddleware)           // All of /admin/*
   * .use("/danger/*", superAuth)   // Only /admin/danger/*
   * .map(() => import("./admin"))
   * ```
   */
  use(
    patternOrMiddleware: string | MiddlewareFn<TEnv>,
    middleware?: MiddlewareFn<TEnv>,
  ): RouteBuilder<T, TEnv, TRoutes, TLocalRoutes>;

  /**
   * Map routes to handlers
   *
   * Supports two patterns:
   *
   * 1. Lazy loading (code-split):
   * ```typescript
   * .routes(homeRoutes)
   * .map(() => import("./handlers/home"))
   * ```
   *
   * 2. Inline definition:
   * ```typescript
   * .routes({ index: "/", about: "/about" })
   * .map(({ route }) => [
   *   route("index", () => <HomePage />),
   *   route("about", () => <AboutPage />),
   * ])
   * ```
   */
  // Inline definition overload - handler receives helpers (must be first for correct inference)
  // Uses TLocalRoutes so route names don't need the prefix
  map<
    H extends (
      helpers: InlineRouteHelpers<TLocalRoutes, TEnv>,
    ) => Array<AllUseItems>,
  >(
    handler: H,
  ): RSCRouter<TEnv, TRoutes>;
  // Lazy loading overload - verifies imported handlers match route definition
  map(
    handler: () =>
      | Array<AllUseItems>
      | Promise<{ default: RouteHandlers<TLocalRoutes> }>
      | Promise<RouteHandlers<TLocalRoutes>>,
  ): RSCRouter<TEnv, TRoutes>;

  /**
   * Accumulated route map for typeof extraction
   * Used for module augmentation: `type AppRoutes = typeof _router.routeMap`
   */
  readonly routeMap: TRoutes;
}

/**
 * RSC Router interface
 * TRoutes accumulates all registered route types through the builder chain
 */
export interface RSCRouter<
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
   * Register routes with a prefix
   * Route keys stay unchanged, only URL patterns get the prefix applied.
   * This enables composable route modules that work regardless of mount point.
   *
   * @throws Compile-time error if route keys conflict with previously registered routes
   */
  routes<const TPrefix extends string, const T extends Record<string, string>>(
    prefix: TPrefix,
    routes: T,
  ): ConflictingKeys<TRoutes, PrefixRoutePatterns<T, TPrefix>> extends never
    ? RouteBuilder<
        RouteDefinition,
        TEnv,
        TRoutes & PrefixRoutePatterns<T, TPrefix>,
        T
      >
    : RouteConflictError<
        ConflictingKeys<TRoutes, PrefixRoutePatterns<T, TPrefix>> & string
      >;

  /**
   * Register routes without a prefix
   * Route types are accumulated through the chain
   *
   * @throws Compile-time error if route keys conflict with previously registered routes
   */
  routes<const T extends Record<string, string>>(
    routes: T,
  ): ConflictingKeys<TRoutes, T> extends never
    ? RouteBuilder<RouteDefinition, TEnv, TRoutes & T, T>
    : RouteConflictError<ConflictingKeys<TRoutes, T> & string>;

  /**
   * Register routes using Django-style URL patterns
   * This is the new API for @rangojs/router - call once with urls() result
   *
   * @example
   * ```typescript
   * createRouter({})
   *   .routes(urlpatterns)  // Single call with urls() result
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
   * Position matters: middleware before any .routes() is global
   *
   * @example
   * ```typescript
   * createRouter({ document: RootLayout })
   *   .use(loggerMiddleware)           // All routes
   *   .use("/api/*", rateLimiter)      // Pattern match
   *   .routes(homeRoutes)
   *   .map(() => import("./home"))
   * ```
   */
  use(
    patternOrMiddleware: string | MiddlewareFn<TEnv>,
    middleware?: MiddlewareFn<TEnv>,
  ): RSCRouter<TEnv, TRoutes>;

  /**
   * Type-safe URL builder for registered routes
   * Types are inferred from the accumulated route registrations
   * Route keys stay unchanged regardless of mount prefix.
   *
   * @example
   * ```typescript
   * // Given: .routes("/shop", { cart: "/cart", detail: "/product/:slug" })
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
   * const _router = createRouter<AppEnv>()
   *   .routes(homeRoutes).map(() => import('./home'))
   *   .routes('/shop', shopRoutes).map(() => import('./shop'));
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
   * Cache configuration (for internal use by RSC handler)
   */
  readonly cache?: RSCRouterOptions<TEnv>["cache"];

  /**
   * Not found component to render when no route matches (for internal use by RSC handler)
   */
  readonly notFound?: RSCRouterOptions<TEnv>["notFound"];

  /**
   * Resolved theme configuration (null if theme not enabled)
   * Used by NavigationProvider to include ThemeProvider and by MetaTags to render theme script
   */
  readonly themeConfig: import("../theme/types.js").ResolvedThemeConfig | null;

  /**
   * Whether connection warmup is enabled.
   * When true, the client sends HEAD /?_rsc_warmup after idle periods
   * and the server responds with 204 No Content.
   */
  readonly warmupEnabled: boolean;

  /**
   * Whether ?__debug_manifest is allowed in production.
   * Always enabled in development.
   * @internal
   */
  readonly allowDebugManifest: boolean;

  /**
   * App-level middleware entries (for internal use by RSC handler)
   * These wrap the entire request/response cycle
   */
  readonly middleware: MiddlewareEntry<TEnv>[];

  /**
   * Nonce provider for CSP (for internal use by createHandler)
   */
  readonly nonce?: NonceProvider<TEnv>;

  /**
   * RSC version string (for internal use by createHandler)
   */
  readonly version?: string;

  /**
   * URL patterns reference for build-time manifest generation
   * @internal
   */
  readonly urlpatterns?: UrlPatterns<TEnv, any>;

  /**
   * Source file path where createRouter() was called.
   * Set via Error.stack parsing at construction time.
   * Used by the Vite plugin to write per-router named-routes.gen.ts files.
   * @internal
   */
  readonly __sourceFile?: string;

  match(request: Request, context: TEnv): Promise<MatchResult>;

  /**
   * Build-time pre-render match. Resolves segments with a BuildContext
   * (no request/env/headers/cookies), skipping middleware and loaders.
   * Used by the Vite plugin to collect pre-render data at build time.
   * @internal
   */
  matchForPrerender(
    pathname: string,
    params: Record<string, string>,
    buildVars?: Record<string, any>,
  ): Promise<{
    segments: SerializedSegmentData[];
    handles: Record<string, SegmentHandleData>;
    routeName: string;
    params: Record<string, string>;
    interceptSegments?: SerializedSegmentData[];
    interceptHandles?: Record<string, SegmentHandleData>;
  } | null>;

  /**
   * Render a single Static handler at build time.
   * Returns the RSC-serialized component string and handle data, or null on failure.
   * @internal
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
    context: TEnv,
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
  } | null>;

  matchPartial(
    request: Request,
    context: TEnv,
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
    context: TEnv,
    error: unknown,
    segmentType?: ErrorInfo["segmentType"],
  ): Promise<MatchResult | null>;

  /**
   * @internal
   * Debug utility to serialize the manifest for inspection
   * Returns a JSON-friendly representation of all routes and layouts
   */
  debugManifest(): Promise<SerializedManifest>;

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
  fetch(
    request: Request,
    env: TEnv & { ctx?: ExecutionContext },
  ): Promise<Response>;
}
