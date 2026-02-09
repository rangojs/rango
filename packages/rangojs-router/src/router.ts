import type { ComponentType } from "react";
import { type ReactNode } from "react";
import { createCacheScope } from "./cache/cache-scope.js";
import type { SegmentCacheStore } from "./cache/types.js";
import { assertClientComponent } from "./component-utils.js";
import { DefaultDocument } from "./components/DefaultDocument.js";
import {
  sanitizeError,
} from "./errors";
import { serializeManifest, type SerializedManifest } from "./debug.js";
import {
  createHref,
  type HrefFunction,
  type PrefixRoutePatterns,
} from "./href.js";
import {
  registerRouteMap,
  getPrecomputedEntries,
  getRouteTrie,
} from "./route-map-builder.js";
import { tryTrieMatch } from "./router/trie-matching.js";
import {
  createRouteHelpers,
  type RouteHandlers,
} from "./route-definition.js";
import MapRootLayout from "./server/root-layout.js";
import type { AllUseItems, IncludeItem } from "./route-types.js";
import type { UrlPatterns } from "./urls.js";
import {
  EntryData,
  InterceptEntry,
  InterceptSelectorContext,
  getContext,
  RSCRouterContext,
  runWithPrefixes,
  type MetricsStore,
} from "./server/context";
import { createHandleStore, type HandleStore } from "./server/handle-store.js";
import { getRequestContext } from "./server/request-context.js";
import type {
  ErrorBoundaryHandler,
  ErrorInfo,
  ErrorPhase,
  HandlerContext,
  LoaderDataResult,
  MatchResult,
  NotFoundBoundaryHandler,
  OnErrorCallback,
  ResolvedRouteMap,
  RouteDefinition,
  RouteEntry,
  TrailingSlashMode,
} from "./types";
import type {
  NonceProvider,
} from "./rsc/types.js";
import type { ExecutionContext } from "./server/request-context.js";

// Extracted router utilities
import {
  createErrorInfo,
  findNearestErrorBoundary as findErrorBoundary,
  findNearestNotFoundBoundary as findNotFoundBoundary,
  invokeOnError,
} from "./router/error-handling.js";

// Extracted segment resolution functions
import {
  resolveAllSegments as _resolveAllSegments,
  resolveLoadersOnly as _resolveLoadersOnly,
  resolveLoadersOnlyWithRevalidation as _resolveLoadersOnlyWithRevalidation,
  buildEntryRevalidateMap as _buildEntryRevalidateMap,
  resolveAllSegmentsWithRevalidation as _resolveAllSegmentsWithRevalidation,
} from "./router/segment-resolution.js";

// Extracted intercept resolution functions
import {
  findInterceptForRoute as _findInterceptForRoute,
  resolveInterceptEntry as _resolveInterceptEntry,
  resolveInterceptLoadersOnly as _resolveInterceptLoadersOnly,
} from "./router/intercept-resolution.js";

// Extracted match API functions
import {
  createMatchContextForFull as _createMatchContextForFull,
  createMatchContextForPartial as _createMatchContextForPartial,
  matchError as _matchError,
} from "./router/match-api.js";

import type { SegmentResolutionDeps, MatchApiDeps } from "./router/types.js";
import { createHandlerContext } from "./router/handler-context.js";
import {
  setupLoaderAccess,
  setupLoaderAccessSilent,
  wrapLoaderWithErrorHandling,
} from "./router/loader-resolution.js";
import { loadManifest } from "./router/manifest.js";
import {
  createMetricsStore,
} from "./router/metrics.js";
import {
  collectRouteMiddleware,
  parsePattern,
  type MiddlewareEntry,
  type MiddlewareFn,
} from "./router/middleware.js";
import {
  extractStaticPrefix,
  findMatch as findRouteMatch,
  isLazyEvaluationNeeded,
  traverseBack,
  type RouteMatchResult,
} from "./router/pattern-matching.js";
import { evaluateRevalidation } from "./router/revalidation.js";
import {
  type RouterContext,
  runWithRouterContext,
} from "./router/router-context.js";
import {
  type ActionContext,
  type MatchContext,
  createPipelineState,
} from "./router/match-context.js";
import { createMatchPartialPipeline } from "./router/match-pipelines.js";
import { collectMatchResult } from "./router/match-result.js";
import { resolveThemeConfig } from "./theme/constants.js";

/**
 * Props passed to the root layout component
 */
export interface RootLayoutProps {
  children: ReactNode;
}

/**
 * Router configuration options
 */
/**
 * Brand marker for identifying router instances at build time.
 * Used by the Vite plugin to auto-discover routers from module exports.
 */
export const RSC_ROUTER_BRAND: "__rsc_router__" = "__rsc_router__";

/**
 * Global registry of all router instances created via createRouter().
 * Each router is keyed by its id (auto-generated or user-provided).
 * Used by the Vite plugin at build time to discover routers and extract
 * manifests, prefix trees, and pre-render candidates.
 */
export const RouterRegistry: Map<string, RSCRouter<any, any>> = new Map();

let routerAutoId = 0;

export interface RSCRouterOptions<TEnv = any> {
  /**
   * Unique identifier for this router instance.
   * Used to namespace static output files and route maps.
   * Auto-generated if not provided.
   */
  id?: string;

  /**
   * Enable performance metrics collection
   * When enabled, metrics are output to console and available via Server-Timing header
   */
  debugPerformance?: boolean;

  /**
   * Allow the `?__debug_manifest` query parameter to return route manifest data as JSON.
   * In development mode this is always enabled regardless of this setting.
   * Defaults to true. Set to false to disable in production.
   * @internal
   */
  allowDebugManifest?: boolean;

  /**
   * Document component that wraps the entire application.
   *
   * This component provides the HTML structure for your app and wraps
   * both normal route content AND error states, preventing the app shell
   * from unmounting during errors (avoids FOUC).
   *
   * Must be a client component ("use client") that accepts { children }.
   *
   * If not provided, a default document with basic HTML structure is used:
   * `<html><head><meta charset/viewport></head><body>{children}</body></html>`
   *
   * @example
   * ```typescript
   * // components/Document.tsx
   * "use client";
   * export function Document({ children }: { children: ReactNode }) {
   *   return (
   *     <html lang="en">
   *       <head>
   *         <link rel="stylesheet" href="/styles.css" />
   *       </head>
   *       <body>
   *         <nav>...</nav>
   *         {children}
   *       </body>
   *     </html>
   *   );
   * }
   *
   * // router.tsx
   * const router = createRouter<AppEnv>({
   *   document: Document,
   * });
   * ```
   */
  document?: ComponentType<RootLayoutProps>;

  /**
   * Default error boundary fallback used when no error boundary is defined in the route tree
   * If not provided, errors will propagate and crash the request
   */
  defaultErrorBoundary?: ReactNode | ErrorBoundaryHandler;

  /**
   * Default not-found boundary fallback used when no notFoundBoundary is defined in the route tree
   * If not provided, DataNotFoundError will be treated as a regular error
   */
  defaultNotFoundBoundary?: ReactNode | NotFoundBoundaryHandler;

  /**
   * Component to render when no route matches the requested URL.
   *
   * This is rendered within your document/app shell with a 404 status code.
   * Use this for a custom 404 page that maintains your app's look and feel.
   *
   * If not provided, a default "Page not found" component is rendered.
   *
   * Can be a static ReactNode or a function receiving the pathname.
   *
   * @example
   * ```typescript
   * // Simple static component
   * const router = createRouter<AppEnv>({
   *   document: Document,
   *   notFound: <NotFound404 />,
   * });
   *
   * // Dynamic component with pathname
   * const router = createRouter<AppEnv>({
   *   document: Document,
   *   notFound: ({ pathname }) => (
   *     <div>
   *       <h1>404 - Not Found</h1>
   *       <p>No page exists at {pathname}</p>
   *       <a href="/">Go home</a>
   *     </div>
   *   ),
   * });
   * ```
   */
  notFound?: ReactNode | ((props: { pathname: string }) => ReactNode);

  /**
   * Callback invoked when an error occurs during request handling.
   *
   * This callback is for notification/logging purposes - it cannot modify
   * the error handling flow. Use errorBoundary() in route definitions to
   * customize error UI.
   *
   * The callback receives comprehensive context about the error including:
   * - The error itself
   * - Phase where it occurred (routing, middleware, loader, handler, etc.)
   * - Request info (URL, method, params)
   * - Route info (routeKey, segmentId)
   * - Environment/bindings
   * - Duration from request start
   *
   * @example
   * ```typescript
   * const router = createRouter<AppEnv>({
   *   onError: (context) => {
   *     // Send to error tracking service
   *     Sentry.captureException(context.error, {
   *       tags: {
   *         phase: context.phase,
   *         route: context.routeKey,
   *       },
   *       extra: {
   *         url: context.url.toString(),
   *         params: context.params,
   *         duration: context.duration,
   *       },
   *     });
   *   },
   * });
   * ```
   */
  onError?: OnErrorCallback<TEnv>;

  /**
   * Cache store for segment caching.
   *
   * When provided, enables route-level caching via cache() boundaries.
   * The store handles persistence (memory, KV, Redis, etc.).
   *
   * Can be a static config or a function receiving env for runtime bindings.
   *
   * @example Static config
   * ```typescript
   * import { MemorySegmentCacheStore } from "rsc-router/rsc";
   *
   * const router = createRouter({
   *   cache: {
   *     store: new MemorySegmentCacheStore({ defaults: { ttl: 60 } }),
   *   },
   * });
   * ```
   *
   * @example Dynamic config with env (e.g., Cloudflare Workers with ExecutionContext)
   * ```typescript
   * const router = createRouter<AppEnv>({
   *   cache: (env) => ({
   *     store: new CFCacheStore({
   *       defaults: { ttl: 60 },
   *       ctx: env.ctx, // ExecutionContext for non-blocking writes
   *     }),
   *   }),
   * });
   * ```
   */
  cache?:
    | { store: SegmentCacheStore; enabled?: boolean }
    | ((env: TEnv & { ctx?: ExecutionContext }) => {
        store: SegmentCacheStore;
        enabled?: boolean;
      });

  /**
   * Theme configuration for automatic theme management.
   *
   * When provided, enables:
   * - ctx.theme and ctx.setTheme() in route handlers
   * - useTheme() hook for client components
   * - FOUC prevention via inline script in MetaTags
   * - Automatic ThemeProvider wrapping in NavigationProvider
   *
   * @example
   * ```typescript
   * const router = createRouter<AppEnv>({
   *   theme: {
   *     defaultTheme: "system",
   *     themes: ["light", "dark"],
   *   }
   * });
   *
   * // In route handler:
   * route("settings", (ctx) => {
   *   const theme = ctx.theme;     // "light" | "dark" | "system"
   *   ctx.setTheme("dark");        // Sets cookie
   *   return <SettingsPage />;
   * });
   *
   * // In client component:
   * import { useTheme } from "@rangojs/router/theme";
   *
   * function ThemeToggle() {
   *   const { theme, setTheme, themes } = useTheme();
   *   return <select value={theme} onChange={e => setTheme(e.target.value)}>
   *     {themes.map(t => <option key={t}>{t}</option>)}
   *   </select>;
   * }
   * ```
   *
   * Use `theme: true` to enable with all defaults.
   */
  theme?: import("./theme/types.js").ThemeConfig | true;

  /**
   * URL patterns to register with the router.
   *
   * Alternative to calling `.routes()` method - allows passing patterns
   * directly in the config for a more concise setup.
   *
   * @example
   * ```typescript
   * import { urls } from "@rangojs/router/server";
   *
   * const urlpatterns = urls(({ path, layout }) => [
   *   path("/", HomePage, { name: "home" }),
   *   path("/about", AboutPage, { name: "about" }),
   * ]);
   *
   * const router = createRouter<AppEnv>({
   *   document: Document,
   *   urls: urlpatterns,
   * });
   * ```
   */
  urls?: UrlPatterns<TEnv, any>;

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
   * createRouter({
   *   nonce: () => true,
   * });
   * ```
   *
   * @example Custom nonce from request context
   * ```tsx
   * createRouter({
   *   nonce: (request, env) => env.nonce,
   * });
   * ```
   */
  nonce?: NonceProvider<TEnv>;

  /**
   * RSC version string included in metadata.
   * The browser sends this back on partial requests to detect version mismatches.
   *
   * Defaults to the auto-generated VERSION from `@rangojs/router:version` virtual module.
   * Only set this if you need a custom versioning strategy.
   *
   * @default VERSION from @rangojs/router:version
   */
  version?: string;

  /**
   * Enable connection warmup to keep TCP+TLS alive after idle periods.
   *
   * When enabled, the client sends a HEAD request after the user returns
   * from an idle period (60s+), prewarming the TLS connection before
   * the next navigation.
   *
   * @default true
   */
  warmup?: boolean;
}

/**
 * Type-level detection of conflicting route keys.
 * Extracts keys that exist in both TExisting and TNew but with different URL patterns.
 * Returns `never` if no conflicts exist.
 *
 * @example
 * ```typescript
 * ConflictingKeys<{ a: "/a" }, { a: "/b" }> // "a" (conflict - same key, different URLs)
 * ConflictingKeys<{ a: "/a" }, { a: "/a" }> // never (no conflict - same key and URL)
 * ConflictingKeys<{ a: "/a" }, { b: "/b" }> // never (no conflict - different keys)
 * ```
 */
type ConflictingKeys<
  TExisting extends Record<string, string>,
  TNew extends Record<string, string>,
> = {
  [K in keyof TExisting & keyof TNew]: TExisting[K] extends TNew[K]
    ? TNew[K] extends TExisting[K]
      ? never // Same value, no conflict
      : K // Different values, conflict
    : K; // Different values, conflict
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
type InlineRouteHelpers<TRoutes extends Record<string, string>, TEnv> = {
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
interface RouteBuilder<
  T extends RouteDefinition,
  TEnv,
  TRoutes extends Record<string, string>,
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
  TRoutes extends Record<string, string> = Record<string, string>,
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
      (NonNullable<T["_routes"]> extends Record<string, string>
        ? NonNullable<T["_routes"]>
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
   * router.href("cart"); // "/shop/cart"
   * router.href("detail", { slug: "widget" }); // "/shop/product/widget"
   * ```
   */
  href: HrefFunction<TRoutes>;

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
  readonly themeConfig: import("./theme/types.js").ResolvedThemeConfig | null;

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

  match(request: Request, context: TEnv): Promise<MatchResult>;

  /**
   * Preview match - returns route middleware without segment resolution.
   * Also returns responseType and handler for response routes (non-RSC short-circuit).
   */
  previewMatch(
    request: Request,
    context: TEnv,
  ): Promise<{
    routeMiddleware?: Array<{
      handler: import("./router/middleware.js").MiddlewareFn;
      params: Record<string, string>;
    }>;
    responseType?: string;
    handler?: Function;
    params?: Record<string, string>;
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

/**
 * Create an RSC router with generic context type
 * Route types are accumulated automatically through the builder chain
 *
 * @example
 * ```typescript
 * interface AppContext {
 *   db: Database;
 *   user?: User;
 * }
 *
 * const router = createRouter<AppContext>({
 *   debugPerformance: true  // Enable metrics
 * });
 *
 * // Route types accumulate through the chain - no module augmentation needed!
 * // Keys stay unchanged, only URL patterns get the prefix
 * router
 *   .routes(homeRoutes)          // accumulates homeRoutes
 *   .map(() => import('./home'))
 *   .routes('/shop', shopRoutes) // accumulates shopRoutes with prefixed URLs
 *   .map(() => import('./shop'));
 *
 * // router.href now has type-safe autocomplete for all registered routes
 * // Given shopRoutes = { cart: "/cart" }, href uses original key:
 * router.href("cart"); // "/shop/cart"
 * ```
 */

export function createRouter<TEnv = any>(
  options: RSCRouterOptions<TEnv> = {},
): RSCRouter<TEnv, {}> {
  const {
    id: userProvidedId,
    debugPerformance = false,
    document: documentOption,
    defaultErrorBoundary,
    defaultNotFoundBoundary,
    notFound,
    onError,
    cache,
    theme: themeOption,
    urls: urlsOption,
    nonce,
    version,
    warmup: warmupOption,
    allowDebugManifest: allowDebugManifestOption = true,
  } = options;

  const routerId = userProvidedId ?? `router_${routerAutoId++}`;

  // Resolve warmup enabled flag (default: true)
  const warmupEnabled = warmupOption !== false;

  // Resolve theme config (null if theme not enabled)
  const resolvedThemeConfig = themeOption
    ? resolveThemeConfig(themeOption)
    : null;

  /**
   * Wrapper for invokeOnError that binds the router's onError callback.
   * Uses the shared utility from router/error-handling.ts for consistent behavior.
   */
  function callOnError(
    error: unknown,
    phase: ErrorPhase,
    context: Parameters<typeof invokeOnError<TEnv>>[3],
  ): void {
    invokeOnError(onError, error, phase, context, "Router");
  }

  // Validate document is a client component
  if (documentOption !== undefined) {
    assertClientComponent(documentOption, "document");
  }

  // Use default document if none provided (keeps internal name as rootLayout)
  const rootLayout = documentOption ?? DefaultDocument;
  const routesEntries: RouteEntry<TEnv>[] = [];
  let mountIndex = 0;

  // Store reference to urlpatterns for runtime manifest generation
  let storedUrlPatterns: UrlPatterns<TEnv, any> | null = null;

  // Global middleware storage
  const globalMiddleware: MiddlewareEntry<TEnv>[] = [];

  // Helper to add middleware entry
  function addMiddleware(
    patternOrMiddleware: string | MiddlewareFn<TEnv>,
    middleware?: MiddlewareFn<TEnv>,
    mountPrefix: string | null = null,
  ): void {
    let pattern: string | null = null;
    let handler: MiddlewareFn<TEnv>;

    if (typeof patternOrMiddleware === "string") {
      // Pattern + middleware
      pattern = patternOrMiddleware;
      if (!middleware) {
        throw new Error(
          "Middleware function required when pattern is provided",
        );
      }
      handler = middleware;
    } else {
      // Just middleware (no pattern)
      handler = patternOrMiddleware;
    }

    // If mount-scoped, prepend mount prefix to pattern
    let fullPattern = pattern;
    if (mountPrefix && pattern) {
      // e.g., mountPrefix="/blog", pattern="/admin/*" → "/blog/admin/*"
      fullPattern =
        pattern === "*" ? `${mountPrefix}/*` : `${mountPrefix}${pattern}`;
    } else if (mountPrefix && !pattern) {
      // Mount-scoped middleware without pattern applies to all of mount
      fullPattern = `${mountPrefix}/*`;
    }

    // Parse pattern into regex
    let regex: RegExp | null = null;
    let paramNames: string[] = [];
    if (fullPattern) {
      const parsed = parsePattern(fullPattern);
      regex = parsed.regex;
      paramNames = parsed.paramNames;
    }

    globalMiddleware.push({
      pattern: fullPattern,
      regex,
      paramNames,
      handler,
      mountPrefix,
    });
  }

  // Track all registered routes with their prefixes for href()
  const mergedRouteMap: Record<string, string> = {};

  // Build a Map from precomputed entries for O(1) lookup by staticPrefix.
  // The array is set at import time (from the virtual module) before createRouter runs.
  const precomputedEntriesRaw = getPrecomputedEntries();
  const precomputedByPrefix: Map<string, Record<string, string>> | null =
    precomputedEntriesRaw
      ? new Map(precomputedEntriesRaw.map((e) => [e.staticPrefix, e.routes]))
      : null;


  // Wrapper to pass debugPerformance to external createMetricsStore
  const getMetricsStore = () => createMetricsStore(debugPerformance);

  // Wrapper to pass defaults to error/notFound boundary finders
  const findNearestErrorBoundary = (entry: EntryData | null) =>
    findErrorBoundary(entry, defaultErrorBoundary);

  const findNearestNotFoundBoundary = (entry: EntryData | null) =>
    findNotFoundBoundary(entry, defaultNotFoundBoundary);

  // Helper to get handleStore from request context
  const getHandleStore = (): HandleStore | undefined => {
    return getRequestContext()?._handleStore;
  };

  // Track a pending handler promise (non-blocking)
  const trackHandler = <T>(promise: Promise<T>): Promise<T> => {
    const store = getHandleStore();
    return store ? store.track(promise) : promise;
  };

  // Wrapper for wrapLoaderWithErrorHandling that uses router's error boundary finder
  // Includes onError callback for loader error notification
  function wrapLoaderPromise<T>(
    promise: Promise<T>,
    entry: EntryData,
    segmentId: string,
    pathname: string,
    errorContext?: {
      request: Request;
      url: URL;
      routeKey?: string;
      params?: Record<string, string>;
      env?: TEnv;
      isPartial?: boolean;
      requestStartTime?: number;
    },
  ): Promise<LoaderDataResult<T>> {
    return wrapLoaderWithErrorHandling(
      promise,
      entry,
      segmentId,
      pathname,
      findNearestErrorBoundary,
      createErrorInfo,
      // Invoke onError when loader fails
      errorContext
        ? (error, ctx) => {
            callOnError(error, "loader", {
              request: errorContext.request,
              url: errorContext.url,
              routeKey: errorContext.routeKey,
              params: errorContext.params,
              segmentId: ctx.segmentId,
              segmentType: "loader",
              loaderName: ctx.loaderName,
              env: errorContext.env,
              isPartial: errorContext.isPartial,
              handledByBoundary: ctx.handledByBoundary,
              requestStartTime: errorContext.requestStartTime,
            });
          }
        : undefined,
    );
  }

  // Dependencies object for extracted segment resolution functions.
  // Captures closure-bound helpers from createRouter.
  const segmentDeps: SegmentResolutionDeps<TEnv> = {
    wrapLoaderPromise,
    trackHandler,
    findNearestErrorBoundary,
    findNearestNotFoundBoundary,
    callOnError,
  };

  // Match API dependencies
  const matchApiDeps: MatchApiDeps<TEnv> = {
    findMatch: (pathname: string, ms?: any) => findMatch(pathname, ms),
    getMetricsStore,
    findInterceptForRoute: (routeKey, parentEntry, selectorContext, isAction) =>
      findInterceptForRoute(routeKey, parentEntry, selectorContext, isAction),
    callOnError,
    findNearestErrorBoundary,
  };

  // Thin wrappers that bind the deps to extracted functions.
  // These maintain the same signatures as the original inline functions
  // so that RouterContext and call sites don't need to change.

  function resolveAllSegments(
    entries: EntryData[],
    routeKey: string,
    params: Record<string, string>,
    context: HandlerContext<any, TEnv>,
    loaderPromises: Map<string, Promise<any>>,
  ) {
    return _resolveAllSegments(entries, routeKey, params, context, loaderPromises, segmentDeps);
  }

  function resolveLoadersOnly(
    entries: EntryData[],
    context: HandlerContext<any, TEnv>,
  ) {
    return _resolveLoadersOnly(entries, context, segmentDeps);
  }

  function resolveLoadersOnlyWithRevalidation(
    entries: EntryData[],
    context: HandlerContext<any, TEnv>,
    clientSegmentIds: Set<string>,
    prevParams: Record<string, string>,
    request: Request,
    prevUrl: URL,
    nextUrl: URL,
    routeKey: string,
    actionContext?: { actionId?: string; actionUrl?: URL; actionResult?: any; formData?: FormData },
  ) {
    return _resolveLoadersOnlyWithRevalidation(
      entries, context, clientSegmentIds, prevParams, request,
      prevUrl, nextUrl, routeKey, segmentDeps, actionContext,
    );
  }

  function buildEntryRevalidateMap(entries: EntryData[]) {
    return _buildEntryRevalidateMap(entries);
  }

  function resolveAllSegmentsWithRevalidation(
    entries: EntryData[],
    routeKey: string,
    params: Record<string, string>,
    context: HandlerContext<any, TEnv>,
    clientSegmentSet: Set<string>,
    prevParams: Record<string, string>,
    request: Request,
    prevUrl: URL,
    nextUrl: URL,
    loaderPromises: Map<string, Promise<any>>,
    actionContext: { actionId?: string; actionUrl?: URL; actionResult?: any; formData?: FormData } | undefined,
    interceptResult: { intercept: InterceptEntry; entry: EntryData } | null,
    localRouteName: string,
    pathname: string,
  ) {
    return _resolveAllSegmentsWithRevalidation(
      entries, routeKey, params, context, clientSegmentSet, prevParams, request,
      prevUrl, nextUrl, loaderPromises, actionContext, interceptResult,
      localRouteName, pathname, segmentDeps,
    );
  }

  function findInterceptForRoute(
    targetRouteKey: string,
    fromEntry: EntryData | null,
    selectorContext: InterceptSelectorContext | null = null,
    isAction: boolean = false,
  ) {
    return _findInterceptForRoute(targetRouteKey, fromEntry, selectorContext, isAction);
  }

  function resolveInterceptEntry(
    interceptEntry: InterceptEntry,
    parentEntry: EntryData,
    params: Record<string, string>,
    context: HandlerContext<any, TEnv>,
    belongsToRoute: boolean = true,
    revalidationContext?: any,
  ) {
    return _resolveInterceptEntry(
      interceptEntry, parentEntry, params, context, belongsToRoute,
      segmentDeps, revalidationContext,
    );
  }

  function resolveInterceptLoadersOnly(
    interceptEntry: InterceptEntry,
    parentEntry: EntryData,
    params: Record<string, string>,
    context: HandlerContext<any, TEnv>,
    belongsToRoute: boolean = true,
    revalidationContext: any,
  ) {
    return _resolveInterceptLoadersOnly(
      interceptEntry, parentEntry, params, context, belongsToRoute,
      segmentDeps, revalidationContext,
    );
  }

  // Detect lazy includes in handler result and create placeholder entries
  // Lazy includes are IncludeItem with lazy: true and _lazyContext
  // Moved to outer scope so it can be reused by evaluateLazyEntry for nested includes
  function findLazyIncludes(items: AllUseItems[]): Array<{
    prefix: string;
    patterns: UrlPatterns<TEnv>;
    context: {
      urlPrefix: string;
      namePrefix: string | undefined;
      parent: unknown;
    };
  }> {
    const lazyItems: Array<{
      prefix: string;
      patterns: UrlPatterns<TEnv>;
      context: {
        urlPrefix: string;
        namePrefix: string | undefined;
        parent: unknown;
      };
    }> = [];

    for (const item of items) {
      if (!item) continue;
      if (item.type === "include") {
        const includeItem = item as IncludeItem;
        if (includeItem.lazy === true && includeItem._lazyContext) {
          lazyItems.push({
            prefix: includeItem.prefix,
            patterns: includeItem.patterns as UrlPatterns<TEnv>,
            context: includeItem._lazyContext,
          });
        }
      }
      // Recursively check nested items (in layouts, etc.)
      if ((item as any).uses && Array.isArray((item as any).uses)) {
        lazyItems.push(...findLazyIncludes((item as any).uses));
      }
    }

    return lazyItems;
  }

  /**
   * Evaluate a lazy entry's patterns and populate its routes
   * This runs the lazy patterns handler and updates the entry in-place
   * Also detects nested lazy includes and registers them as new entries
   */
  function evaluateLazyEntry(entry: RouteEntry<TEnv>): void {
    if (!entry.lazy || entry.lazyEvaluated || !entry.lazyPatterns) {
      return;
    }

    // Check for pre-computed routes from build-time data.
    // Only leaf nodes (no nested includes) are precomputed, so entries with
    // nested lazy includes fall through to the handler below.
    if (precomputedByPrefix) {
      const routes = precomputedByPrefix.get(entry.staticPrefix);
      if (routes) {
        entry.lazyEvaluated = true;
        entry.routes = routes as ResolvedRouteMap<any>;
        for (const [name, pattern] of Object.entries(routes)) {
          mergedRouteMap[name] = pattern;
        }
        registerRouteMap(mergedRouteMap);
        return;
      }
    }

    // Mark as evaluated immediately to prevent concurrent evaluation.
    // JS is single-threaded but handlers.handler() could theoretically yield,
    // and the while-loop in findMatch retries after evaluation.
    entry.lazyEvaluated = true;

    const lazyPatterns = entry.lazyPatterns as UrlPatterns<TEnv>;
    const lazyContext = entry.lazyContext;

    // Create a new context for evaluating the lazy patterns
    const manifest = new Map<string, EntryData>();
    const patterns = new Map<string, string>();
    const patternsByPrefix = new Map<string, Map<string, string>>();
    const trailingSlashMap = new Map<string, TrailingSlashMode>();

    // Capture the handler result to detect nested lazy includes
    let handlerResult: AllUseItems[] = [];

    RSCRouterContext.run(
      {
        manifest,
        patterns,
        patternsByPrefix,
        trailingSlash: trailingSlashMap,
        namespace: "lazy",
        parent: (lazyContext?.parent as EntryData | null) ?? null,
        counters: {},
      },
      () => {
        // Run the lazy patterns handler with the original context prefixes
        // The prefix comes from the IncludeItem stored in lazyPatterns
        const includePrefix = (entry as any)._lazyPrefix || "";
        const fullPrefix = (lazyContext?.urlPrefix || "") + includePrefix;

        if (fullPrefix || lazyContext?.namePrefix) {
          runWithPrefixes(fullPrefix, lazyContext?.namePrefix, () => {
            handlerResult = lazyPatterns.handler() as AllUseItems[];
          });
        } else {
          handlerResult = lazyPatterns.handler() as AllUseItems[];
        }
      },
    );

    // Populate the entry's routes from the patterns
    const routesObject: Record<string, string> = {};
    for (const [name, pattern] of patterns.entries()) {
      routesObject[name] = pattern;
      // Also add to merged route map for href() support
      const existingPattern = mergedRouteMap[name];
      if (existingPattern !== undefined && existingPattern !== pattern) {
        console.warn(
          `[@rangojs/router] Route name conflict: "${name}" already maps to "${existingPattern}", ` +
            `overwriting with "${pattern}" (from lazy include). Use unique route names to avoid this.`,
        );
      }
      mergedRouteMap[name] = pattern;
    }

    // Update the entry in-place
    entry.routes = routesObject as ResolvedRouteMap<any>;

    // Note: Do NOT clear lazyPatterns/lazyContext here.
    // loadManifest() needs them on every request to re-run the handler
    // in the correct AsyncLocalStorage context (Store.manifest).

    // Update trailing slash config if available
    if (trailingSlashMap.size > 0) {
      entry.trailingSlash = Object.fromEntries(trailingSlashMap);
    }

    // Detect nested lazy includes and register them as new entries
    const nestedLazyIncludes = findLazyIncludes(handlerResult);
    for (const lazyInclude of nestedLazyIncludes) {
      // Compute the full URL prefix (combining parent prefix if any)
      const fullPrefix = lazyInclude.context.urlPrefix
        ? lazyInclude.context.urlPrefix + lazyInclude.prefix
        : lazyInclude.prefix;

      const nestedEntry: RouteEntry<TEnv> & { _lazyPrefix?: string } = {
        prefix: "",
        staticPrefix: extractStaticPrefix(fullPrefix),
        routes: {} as ResolvedRouteMap<any>, // Empty until first match
        trailingSlash: entry.trailingSlash,
        handler: (lazyInclude.patterns as UrlPatterns<TEnv>).handler,
        mountIndex: entry.mountIndex,
        // Lazy evaluation fields
        lazy: true,
        lazyPatterns: lazyInclude.patterns,
        lazyContext: lazyInclude.context,
        lazyEvaluated: false,
        // Store the include prefix for evaluation
        _lazyPrefix: lazyInclude.prefix,
      };
      // Insert nested lazy entry before any entry whose staticPrefix is a
      // prefix of (but shorter than) this lazy entry's staticPrefix.
      // This ensures more specific lazy includes are matched before
      // less specific eager entries (e.g., "/href/nested" before "/href/:id").
      const nestedPrefix = nestedEntry.staticPrefix;
      let insertIndex = routesEntries.length;
      if (nestedPrefix) {
        for (let i = 0; i < routesEntries.length; i++) {
          const existing = routesEntries[i]!;
          if (
            nestedPrefix.startsWith(existing.staticPrefix) &&
            nestedPrefix.length > existing.staticPrefix.length
          ) {
            insertIndex = i;
            break;
          }
        }
      }
      routesEntries.splice(insertIndex, 0, nestedEntry);
    }

    // Re-register route map for runtime href() usage
    registerRouteMap(mergedRouteMap);
  }

  // Single-entry cache for findMatch to avoid redundant matching within the same request.
  // previewMatch and match both call findMatch with the same pathname — this ensures
  // the route matching work (which may check thousands of routes) only happens once.
  let lastFindMatchPathname: string | null = null;
  let lastFindMatchResult: RouteMatchResult<TEnv> | null = null;

  // Wrapper for findMatch that uses routesEntries
  // Handles lazy evaluation by evaluating lazy entries on first match.
  // Phase 1: try O(path_length) trie match.
  // Phase 2: fall back to regex iteration.
  function findMatch(
    pathname: string,
    ms?: MetricsStore,
  ): RouteMatchResult<TEnv> | null {
    // Return cached result if same pathname (avoids double-match per request)
    if (lastFindMatchPathname === pathname) {
      return lastFindMatchResult;
    }

    // Helper to push sub-metrics
    const pushMetric = ms
      ? (label: string, start: number) => {
          ms.metrics.push({
            label,
            duration: performance.now() - start,
            startTime: start - ms.requestStart,
          });
        }
      : undefined;

    // Phase 1: Try trie match (O(path_length))
    const routeTrie = getRouteTrie();
    if (routeTrie) {
      const trieStart = performance.now();
      const trieResult = tryTrieMatch(routeTrie, pathname);
      pushMetric?.("match:trie", trieStart);

      if (trieResult) {
        // Find the RouteEntry that contains this route.
        // Multiple entries can share the same staticPrefix (e.g., several
        // include("/", patterns) calls all produce staticPrefix=""). Evaluate
        // each candidate and pick the one whose routes include the matched key.
        const entryStart = performance.now();
        let entry: RouteEntry<TEnv> | undefined;
        let fallbackEntry: RouteEntry<TEnv> | undefined;

        for (const e of routesEntries) {
          if (e.staticPrefix !== trieResult.sp) continue;
          if (!fallbackEntry) fallbackEntry = e;
          evaluateLazyEntry(e);
          if (
            e.routes &&
            trieResult.routeKey in (e.routes as Record<string, unknown>)
          ) {
            entry = e;
            break;
          }
        }

        // If no entry had the route in its routes map, use the first matching
        // entry as fallback (handles main entry with inline routes not yet
        // reflected in its routes object).
        if (!entry) entry = fallbackEntry;

        // If entry not found (nested include not yet discovered), evaluate parent
        if (!entry) {
          const parent = routesEntries.find(
            (e) =>
              trieResult.sp.startsWith(e.staticPrefix) &&
              e.staticPrefix !== trieResult.sp,
          );
          if (parent) {
            const lazyStart = performance.now();
            evaluateLazyEntry(parent);
            pushMetric?.("match:lazy-eval", lazyStart);
          }
          entry = routesEntries.find((e) => e.staticPrefix === trieResult.sp);
        }
        pushMetric?.("match:entry-resolve", entryStart);

        if (entry) {
          lastFindMatchPathname = pathname;
          lastFindMatchResult = {
            entry,
            routeKey: trieResult.routeKey,
            params: trieResult.params,
            optionalParams: new Set(trieResult.optionalParams || []),
            redirectTo: trieResult.redirectTo,
            ancestry: trieResult.ancestry,
            ...(trieResult.pr ? { pr: true } : {}),
            ...(trieResult.pt ? { pt: true } : {}),
            ...(trieResult.responseType ? { responseType: trieResult.responseType } : {}),
          };
          return lastFindMatchResult;
        }
      }
    }

    // Phase 2: Fall back to existing matching (regex iteration)
    const regexStart = performance.now();
    let result = findRouteMatch(pathname, routesEntries);

    // If we hit a lazy entry that needs evaluation, evaluate and retry.
    // Cap iterations to prevent infinite loops from pathological nesting.
    const MAX_LAZY_ITERATIONS = 100;
    let iterations = 0;
    while (isLazyEvaluationNeeded(result)) {
      if (++iterations > MAX_LAZY_ITERATIONS) {
        console.error(
          `[@rangojs/router] Exceeded ${MAX_LAZY_ITERATIONS} lazy evaluation iterations ` +
            `for pathname "${pathname}". This likely indicates circular lazy includes.`,
        );
        lastFindMatchPathname = pathname;
        lastFindMatchResult = null;
        return null;
      }
      evaluateLazyEntry(result.lazyEntry);
      result = findRouteMatch(pathname, routesEntries);
    }
    pushMetric?.("match:regex-fallback", regexStart);

    lastFindMatchPathname = pathname;
    lastFindMatchResult = result;
    return result;
  }


  /**
   * Match request and return segments (document/SSR requests)
   *
   * Uses generator middleware pipeline for clean separation of concerns:
   * - cache-lookup: Check cache first
   * - segment-resolution: Resolve segments on cache miss
   * - cache-store: Store results in cache
   * - background-revalidation: SWR revalidation
   */
  async function match(request: Request, env: TEnv): Promise<MatchResult> {
    // Build RouterContext with all closure functions needed by middleware
    const routerCtx: RouterContext<TEnv> = {
      findMatch,
      loadManifest,
      traverseBack,
      createHandlerContext,
      setupLoaderAccess,
      setupLoaderAccessSilent,
      getContext,
      getMetricsStore,
      createCacheScope,
      findInterceptForRoute,
      resolveAllSegmentsWithRevalidation,
      resolveInterceptEntry,
      evaluateRevalidation,
      getRequestContext,
      resolveAllSegments,
      createHandleStore,
      buildEntryRevalidateMap,
      resolveLoadersOnlyWithRevalidation,
      resolveInterceptLoadersOnly,
      resolveLoadersOnly,
    };

    return runWithRouterContext(routerCtx, async () => {
      const result = await createMatchContextForFull(request, env);

      // Handle redirect case
      if ("type" in result && result.type === "redirect") {
        return {
          segments: [],
          matched: [],
          diff: [],
          params: {},
          redirect: result.redirectUrl,
        };
      }

      const ctx = result as MatchContext<TEnv>;

      try {
        const state = createPipelineState();
        const pipeline = createMatchPartialPipeline(ctx, state);
        return await collectMatchResult(pipeline, ctx, state);
      } catch (error) {
        if (error instanceof Response) throw error;
        // Report unhandled errors during full match pipeline
        callOnError(error, "routing", {
          request,
          url: ctx.url,
          env,
          isPartial: false,
          handledByBoundary: false,
        });
        throw sanitizeError(error);
      }
    });
  }

  async function matchError(
    request: Request,
    _context: TEnv,
    error: unknown,
    segmentType: ErrorInfo["segmentType"] = "route",
  ): Promise<MatchResult | null> {
    return _matchError(request, _context, error, matchApiDeps, defaultErrorBoundary, segmentType);
  }


  async function createMatchContextForFull(
    request: Request,
    env: TEnv,
  ) {
    return _createMatchContextForFull(request, env, matchApiDeps, findInterceptForRoute);
  }

  async function createMatchContextForPartial(
    request: Request,
    env: TEnv,
    actionContext?: { actionId?: string; actionUrl?: URL; actionResult?: any; formData?: FormData },
  ) {
    return _createMatchContextForPartial(request, env, matchApiDeps, findInterceptForRoute, actionContext);
  }

  /**
   * Match partial request with revalidation
   *
   * Uses generator middleware pipeline for clean separation of concerns:
   * - cache-lookup: Check cache first
   * - segment-resolution: Resolve segments on cache miss
   * - intercept-resolution: Handle intercept routes
   * - cache-store: Store results in cache
   * - background-revalidation: SWR revalidation
   */
  async function matchPartial(
    request: Request,
    context: TEnv,
    actionContext?: ActionContext,
  ): Promise<MatchResult | null> {
    // Build RouterContext with all closure functions needed by middleware
    const routerCtx: RouterContext<TEnv> = {
      findMatch,
      loadManifest,
      traverseBack,
      createHandlerContext,
      setupLoaderAccess,
      setupLoaderAccessSilent,
      getContext,
      getMetricsStore,
      createCacheScope,
      findInterceptForRoute,
      resolveAllSegmentsWithRevalidation,
      resolveInterceptEntry,
      evaluateRevalidation,
      getRequestContext,
      resolveAllSegments,
      createHandleStore,
      buildEntryRevalidateMap,
      resolveLoadersOnlyWithRevalidation,
      resolveInterceptLoadersOnly,
    };

    return runWithRouterContext(routerCtx, async () => {
      const ctx = await createMatchContextForPartial(
        request,
        context,
        actionContext,
      );
      if (!ctx) return null;

      try {
        const state = createPipelineState();
        const pipeline = createMatchPartialPipeline(ctx, state);
        return await collectMatchResult(pipeline, ctx, state);
      } catch (error) {
        if (error instanceof Response) throw error;
        // Report unhandled errors during partial match pipeline
        callOnError(error, actionContext ? "action" : "revalidation", {
          request,
          url: ctx.url,
          env: context,
          actionId: actionContext?.actionId,
          isPartial: true,
          handledByBoundary: false,
        });
        throw sanitizeError(error);
      }
    });
  }

  /**
   * Preview match - returns route middleware without segment resolution.
   * Also returns responseType and handler for response routes (non-RSC short-circuit).
   */
  async function previewMatch(
    request: Request,
    _context: TEnv,
  ): Promise<{
    routeMiddleware?: Array<{
      handler: import("./router/middleware.js").MiddlewareFn;
      params: Record<string, string>;
    }>;
    responseType?: string;
    handler?: Function;
    params?: Record<string, string>;
  } | null> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Quick route matching
    const matched = findMatch(pathname);
    if (!matched) {
      return null;
    }

    // Skip redirect check - will be handled in full match
    if (matched.redirectTo) {
      return { routeMiddleware: undefined };
    }

    // Load manifest (without segment resolution)
    const manifestEntry = await loadManifest(
      matched.entry,
      matched.routeKey,
      pathname,
      undefined, // No metrics store for preview
      false, // isSSR - doesn't matter for preview
    );

    // Collect route-level middleware from entry tree
    // Includes middleware from orphan layouts (inline layouts within routes)
    const routeMiddleware = collectRouteMiddleware(
      traverseBack(manifestEntry),
      matched.params,
    );

    // Check for response type (from trie match or manifest entry)
    const responseType = matched.responseType ||
      (manifestEntry.type === "route" ? manifestEntry.responseType : undefined);

    return {
      routeMiddleware: routeMiddleware.length > 0 ? routeMiddleware : undefined,
      ...(responseType ? {
        responseType,
        handler: manifestEntry.type === "route" ? manifestEntry.handler : undefined,
        params: matched.params,
      } : {}),
    };
  }

  /**
   * Create route builder with accumulated route types
   * The TNewRoutes type parameter captures the new routes being added
   */
  function createRouteBuilder<TNewRoutes extends Record<string, string>>(
    prefix: string,
    routes: TNewRoutes,
  ): RouteBuilder<RouteDefinition, TEnv, any, TNewRoutes> {
    const currentMountIndex = mountIndex++;

    // Merge routes into the href map
    // Keys stay unchanged for composability - only URL patterns get prefixed
    const routeEntries = routes as Record<string, string>;
    for (const [key, pattern] of Object.entries(routeEntries)) {
      // Build prefixed pattern: "/shop" + "/cart" -> "/shop/cart"
      const prefixedPattern =
        prefix && pattern !== "/"
          ? `${prefix}${pattern}`
          : prefix && pattern === "/"
            ? prefix
            : pattern;

      // Runtime validation: warn if key already exists with different pattern
      const existingPattern = mergedRouteMap[key];
      if (
        existingPattern !== undefined &&
        existingPattern !== prefixedPattern
      ) {
        console.warn(
          `[rsc-router] Route key conflict: "${key}" already maps to "${existingPattern}", ` +
            `overwriting with "${prefixedPattern}". Use unique key names to avoid this.`,
        );
      }

      // Use original key - enables reusable route modules
      mergedRouteMap[key] = prefixedPattern;
    }

    // Auto-register route map for runtime href() usage
    registerRouteMap(mergedRouteMap);

    // Extract trailing slash config if present (attached by route())
    const trailingSlashConfig = (routes as any).__trailingSlash as
      | Record<string, TrailingSlashMode>
      | undefined;

    // Create builder object so .use() can return it
    const builder: RouteBuilder<RouteDefinition, TEnv, any, TNewRoutes> = {
      use(
        patternOrMiddleware: string | MiddlewareFn<TEnv>,
        middleware?: MiddlewareFn<TEnv>,
      ) {
        // Mount-scoped middleware - prefix is the mount prefix
        addMiddleware(patternOrMiddleware, middleware, prefix || null);
        return builder;
      },

      map(
        handler:
          | ((
              helpers: InlineRouteHelpers<TNewRoutes, TEnv>,
            ) => Array<AllUseItems>)
          | (() =>
              | Array<AllUseItems>
              | Promise<{ default: () => Array<AllUseItems> }>
              | Promise<() => Array<AllUseItems>>),
      ) {
        // Store handler as-is - detection happens at call time based on return type
        // Both patterns use the same signature:
        // - Inline: ({ route }) => [...] - receives helpers, returns Array
        // - Lazy: () => import(...) - ignores helpers, returns Promise
        routesEntries.push({
          prefix,
          staticPrefix: extractStaticPrefix(prefix),
          routes: routes as ResolvedRouteMap<any>,
          trailingSlash: trailingSlashConfig,
          handler: handler as any,
          mountIndex: currentMountIndex,
        });
        // Return router with accumulated types
        // At runtime this is the same object, but TypeScript tracks the accumulated route types
        return router as any;
      },

      // Expose accumulated route map for typeof extraction
      get routeMap() {
        return mergedRouteMap as TNewRoutes;
      },
    };

    return builder;
  }

  /**
   * Router instance
   * The type system tracks accumulated routes through the builder chain
   * Initial TRoutes is {} (empty) to avoid poisoning accumulated types with Record<string, string>
   */
  const router: RSCRouter<TEnv, {}> = {
    __brand: RSC_ROUTER_BRAND,
    id: routerId,

    routes(
      prefixOrRoutes: string | Record<string, string> | UrlPatterns<TEnv>,
      maybeRoutes?: Record<string, string>,
    ): any {
      // Note: Multiple .routes() calls are allowed for backwards compatibility
      // with the old map() pattern. For new code, prefer urls() with include().

      // Check if argument is UrlPatterns (new Django-style API)
      // Detect by checking for handler and definitions properties
      if (
        typeof prefixOrRoutes === "object" &&
        prefixOrRoutes !== null &&
        "handler" in prefixOrRoutes &&
        "definitions" in prefixOrRoutes &&
        typeof (prefixOrRoutes as UrlPatterns<TEnv>).handler === "function"
      ) {
        const urlPatterns = prefixOrRoutes as UrlPatterns<TEnv>;
        // Store reference for runtime manifest generation
        storedUrlPatterns = urlPatterns;
        const currentMountIndex = mountIndex++;

        // Create manifest and patterns maps for route registration
        const manifest = new Map<string, EntryData>();
        const patterns = new Map<string, string>();
        const patternsByPrefix = new Map<string, Map<string, string>>();
        const trailingSlashMap = new Map<string, TrailingSlashMode>();

        // Run the handler once to extract patterns for route matching
        // Note: loadManifest will re-run the handler to register entries in its context
        // Lazy includes are detected in the return value and handled separately
        let handlerResult: AllUseItems[] = [];
        RSCRouterContext.run(
          {
            manifest,
            patterns,
            patternsByPrefix,
            trailingSlash: trailingSlashMap,
            namespace: "root",
            parent: null,
            counters: {},
          },
          () => {
            // Execute the handler to collect patterns
            handlerResult = urlPatterns.handler() as AllUseItems[];
          },
        );

        // Store the ORIGINAL handler - loadManifest will re-run it to register manifest entries
        // Convert trailingSlash map to object for the router
        const trailingSlashConfig =
          trailingSlashMap.size > 0
            ? Object.fromEntries(trailingSlashMap)
            : undefined;

        // Create separate RouteEntry for each URL prefix group
        // This enables prefix-based short-circuit optimization
        if (patternsByPrefix.size > 0) {
          for (const [prefix, prefixPatterns] of patternsByPrefix.entries()) {
            const routesObject: Record<string, string> = {};
            for (const [name, pattern] of prefixPatterns.entries()) {
              routesObject[name] = pattern;
            }

            routesEntries.push({
              // prefix is "" because patterns already include the URL prefix
              // (e.g., "/site/:locale/user1/:id" not just "/user1/:id")
              prefix: "",
              // staticPrefix is the actual prefix for short-circuit optimization
              staticPrefix: extractStaticPrefix(prefix),
              routes: routesObject as ResolvedRouteMap<any>,
              trailingSlash: trailingSlashConfig,
              handler: urlPatterns.handler,
              mountIndex: currentMountIndex,
            });
          }
        } else {
          // Fallback: no prefix grouping, use flat patterns map
          const routesObject: Record<string, string> = {};
          for (const [name, pattern] of patterns.entries()) {
            routesObject[name] = pattern;
          }

          routesEntries.push({
            prefix: "",
            staticPrefix: "",
            routes: routesObject as ResolvedRouteMap<any>,
            trailingSlash: trailingSlashConfig,
            handler: urlPatterns.handler,
            mountIndex: currentMountIndex,
          });
        }

        // Build route map from registered patterns
        for (const [name, pattern] of patterns.entries()) {
          // Runtime validation: warn if key already exists with different pattern
          const existingPattern = mergedRouteMap[name];
          if (existingPattern !== undefined && existingPattern !== pattern) {
            console.warn(
              `[@rangojs/router] Route name conflict: "${name}" already maps to "${existingPattern}", ` +
                `overwriting with "${pattern}". Use unique route names to avoid this.`,
            );
          }
          mergedRouteMap[name] = pattern;
        }

        // Detect lazy includes in handler result and create placeholder entries
        // Uses findLazyIncludes from outer scope (shared with evaluateLazyEntry)
        const lazyIncludes = findLazyIncludes(handlerResult);

        // Create placeholder RouteEntry for each lazy include
        for (const lazyInclude of lazyIncludes) {
          // Compute the full URL prefix (combining parent prefix if any)
          const fullPrefix = lazyInclude.context.urlPrefix
            ? lazyInclude.context.urlPrefix + lazyInclude.prefix
            : lazyInclude.prefix;

          const lazyEntry: RouteEntry<TEnv> & { _lazyPrefix?: string } = {
            prefix: "",
            staticPrefix: extractStaticPrefix(fullPrefix),
            routes: {} as ResolvedRouteMap<any>, // Empty until first match
            trailingSlash: trailingSlashConfig,
            handler: urlPatterns.handler,
            mountIndex: currentMountIndex,
            // Lazy evaluation fields
            lazy: true,
            lazyPatterns: lazyInclude.patterns,
            lazyContext: lazyInclude.context,
            lazyEvaluated: false,
            // Store the include prefix for evaluation
            _lazyPrefix: lazyInclude.prefix,
          };
          // Insert lazy entry before any entry whose staticPrefix is a
          // prefix of (but shorter than) this lazy entry's staticPrefix.
          // This ensures more specific lazy includes are matched before
          // less specific eager entries (e.g., "/href/nested" before "/href/:id").
          const lazyPrefix = lazyEntry.staticPrefix;
          let insertIndex = routesEntries.length;
          if (lazyPrefix) {
            for (let i = 0; i < routesEntries.length; i++) {
              const existing = routesEntries[i]!;
              if (
                lazyPrefix.startsWith(existing.staticPrefix) &&
                lazyPrefix.length > existing.staticPrefix.length
              ) {
                insertIndex = i;
                break;
              }
            }
          }
          routesEntries.splice(insertIndex, 0, lazyEntry);
        }

        // Auto-register route map for runtime href() usage
        registerRouteMap(mergedRouteMap);

        // Return the router (no .map() needed for UrlPatterns)
        return router;
      }

      // Legacy API: route() + map() pattern
      // If second argument exists, first is prefix
      if (maybeRoutes !== undefined) {
        return createRouteBuilder(prefixOrRoutes as string, maybeRoutes);
      }
      // Otherwise, first argument is routes with empty prefix
      return createRouteBuilder("", prefixOrRoutes as Record<string, string>);
    },

    use(
      patternOrMiddleware: string | MiddlewareFn<TEnv>,
      middleware?: MiddlewareFn<TEnv>,
    ): any {
      // Global middleware - no mount prefix
      addMiddleware(patternOrMiddleware, middleware, null);
      return router;
    },

    // Type-safe URL builder using merged route map
    // Types are tracked through the builder chain via TRoutes parameter
    href: createHref(mergedRouteMap),

    // Expose accumulated route map for typeof extraction
    // Returns {} initially, but builder chain accumulates specific route types
    get routeMap() {
      return mergedRouteMap as {};
    },

    // Expose rootLayout for renderSegments
    rootLayout,

    // Expose onError callback for error handling
    onError,

    // Expose cache configuration for RSC handler
    cache,

    // Expose notFound component for RSC handler
    notFound,

    // Expose resolved theme configuration for NavigationProvider and MetaTags
    themeConfig: resolvedThemeConfig,

    // Expose warmup enabled flag for handler and client
    warmupEnabled,

    // Expose debug manifest flag for handler
    allowDebugManifest: allowDebugManifestOption,

    // Expose global middleware for RSC handler
    middleware: globalMiddleware,

    match,
    matchPartial,
    matchError,
    previewMatch,

    // Expose nonce provider for fetch
    nonce,

    // Expose version for fetch
    version,

    // Expose urlpatterns for runtime manifest generation
    get urlpatterns() {
      return storedUrlPatterns ?? undefined;
    },

    // RSC request handler (lazily created on first call)
    fetch: (() => {
      // Handler is created on first call and reused
      let handler:
        | ((
            request: Request,
            env: TEnv & { ctx?: ExecutionContext },
          ) => Promise<Response>)
        | null = null;

      return async (
        request: Request,
        env: TEnv & { ctx?: ExecutionContext },
      ) => {
        if (!handler) {
          // Lazy import deferred to first request to avoid dev mode issues
          const { createRSCHandler } = await import("./rsc/handler.js");
          handler = createRSCHandler({
            router: router as any,
            cache,
            nonce,
            version,
          });
        }
        return handler(request, env);
      };
    })(),

    // Debug utility for manifest inspection
    async debugManifest(): Promise<SerializedManifest> {
      const manifest = new Map<string, EntryData>();

      for (const entry of routesEntries) {
        const Store = {
          manifest,
          namespace: `debug.M${entry.mountIndex}`,
          parent: null as EntryData | null,
          counters: {} as Record<string, number>,
          mountIndex: entry.mountIndex,
          patterns: new Map<string, string>(),
          trailingSlash: new Map<string, TrailingSlashMode>(),
        };

        await getContext().runWithStore(
          Store,
          `debug.M${entry.mountIndex}`,
          null,
          async () => {
            const helpers = createRouteHelpers();

            // Wrap handler execution in root layout (same as loadManifest)
            let promiseResult: Promise<any> | null = null;
            helpers.layout(MapRootLayout, () => {
              const result = entry.handler();
              if (result instanceof Promise) {
                promiseResult = result;
                return [];
              }
              return result;
            });

            if (promiseResult !== null) {
              const load = await (promiseResult as Promise<any>);
              if (load && typeof load === "object" && "default" in load) {
                const useItems = load.default;
                if (typeof useItems === "function") {
                  useItems(helpers);
                }
              }
            }
          },
        );
      }

      return serializeManifest(manifest);
    },
  };

  // Register router in the global registry for build-time discovery
  RouterRegistry.set(routerId, router);

  // If urls option was provided, auto-register them
  if (urlsOption) {
    return router.routes(urlsOption) as RSCRouter<TEnv, {}>;
  }

  return router;
}
