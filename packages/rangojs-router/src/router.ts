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
  createReverse,
  type ReverseFunction,
  type PrefixRoutePatterns,
} from "./reverse.js";
import {
  registerRouteMap,
  getPrecomputedEntries,
  getRouteTrie,
  getRouterManifest,
  getRouterTrie,
  getRouterPrecomputedEntries,
  ensureRouterManifest,
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
  ResolvedSegment,
  RouteEntry,
  TrailingSlashMode,
  InternalHandlerContext,
} from "./types";
import type {
  NonceProvider,
} from "./rsc/types.js";
import {
  runWithRequestContext,
  type RequestContext,
  type ExecutionContext,
} from "./server/request-context.js";
import type { SerializedSegmentData, SegmentHandleData } from "./cache/types.js";

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
import { createHandlerContext, createPrerenderContext, createStaticContext } from "./router/handler-context.js";
import {
  setupLoaderAccess,
  setupLoaderAccessSilent,
  setupBuildUse,
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
import {
  runWithRouterLogContext,
  withRouterLogScope,
} from "./router/logging.js";
import { resolveThemeConfig } from "./theme/constants.js";

// Response type -> MIME type used for Accept header matching
const RESPONSE_TYPE_MIME: Record<string, string> = {
  json: "application/json",
  text: "text/plain",
  xml: "application/xml",
  html: "text/html",
  md: "text/markdown",
};

// Reverse lookup: MIME type -> response type tag (e.g. "text/html" -> "html")
const MIME_RESPONSE_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(RESPONSE_TYPE_MIME).map(([tag, mime]) => [mime, tag]),
);

type NamedRouteEntry = string | { path: string; search?: Record<string, string> };
type UrlPatternsResolver<TEnv> = () => UrlPatterns<TEnv, any> | null | undefined;

function flattenNamedRoutes(
  routeNames?: Record<string, NamedRouteEntry>,
): Record<string, string> {
  if (!routeNames) return {};
  const flattened: Record<string, string> = {};
  for (const [name, entry] of Object.entries(routeNames)) {
    flattened[name] = typeof entry === "string" ? entry : entry.path;
  }
  return flattened;
}

interface AcceptEntry {
  mime: string;
  q: number;
  order: number;
}

/**
 * Parse an Accept header into a sorted array of MIME entries.
 * Respects q-values (default 1.0) and uses client order as tiebreaker
 * when q-values are equal (matching Express/Hono behavior).
 */
function parseAcceptTypes(accept: string): AcceptEntry[] {
  const entries: AcceptEntry[] = [];
  const parts = accept.split(",");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const segments = part.split(";");
    const mime = segments[0]!.trim();
    if (!mime) continue;
    let q = 1.0;
    for (let j = 1; j < segments.length; j++) {
      const param = segments[j]!.trim();
      if (param.startsWith("q=")) {
        q = Math.max(0, Math.min(1, Number(param.slice(2)) || 0));
      }
    }
    entries.push({ mime, q, order: i });
  }
  // Sort: highest q first, then lowest client order first (stable)
  entries.sort((a, b) => b.q - a.q || a.order - b.order);
  return entries;
}

// Sentinel response type for RSC routes in negotiation candidates
const RSC_RESPONSE_TYPE = "__rsc__";

/**
 * Pick the best negotiate variant by walking the client's sorted Accept list.
 * For each accepted MIME type (in q-value/order priority), check if any
 * candidate serves that type. Wildcards (*\/*) match the first candidate.
 * Falls back to the first candidate if nothing matches.
 */
function pickNegotiateVariant(
  acceptEntries: AcceptEntry[],
  candidates: Array<{ routeKey: string; responseType: string }>,
): { routeKey: string; responseType: string } {
  // Build a MIME -> candidate lookup for O(1) matching
  const byCandidateMime = new Map<string, { routeKey: string; responseType: string }>();
  for (const c of candidates) {
    const mime = c.responseType === RSC_RESPONSE_TYPE ? "text/html" : RESPONSE_TYPE_MIME[c.responseType];
    if (mime && !byCandidateMime.has(mime)) {
      byCandidateMime.set(mime, c);
    }
  }

  for (const entry of acceptEntries) {
    if (entry.q === 0) continue;
    // Wildcard matches first candidate
    if (entry.mime === "*/*") return candidates[0]!;
    // Type wildcard (e.g. "text/*") — match first candidate with that type
    if (entry.mime.endsWith("/*")) {
      const typePrefix = entry.mime.slice(0, entry.mime.indexOf("/"));
      for (const [mime, candidate] of byCandidateMime) {
        if (mime.startsWith(typePrefix + "/")) return candidate;
      }
      continue;
    }
    const match = byCandidateMime.get(entry.mime);
    if (match) return match;
  }
  // No match — use first candidate as default
  return candidates[0]!;
}

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
   * Injected by the Vite transform at compile time.
   * Hash of filename + line number for stable cross-environment ID.
   * @internal
   */
  $$id?: string;

  /**
   * Enable performance metrics collection
   * When enabled, metrics are output to console and available via Server-Timing header
   */
  debugPerformance?: boolean;

  /**
   * Allow the `?__debug_manifest` query parameter to return route manifest data as JSON.
   * In development mode this is always enabled regardless of this setting.
   * Defaults to false. Set to true to enable in production.
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
  urls?: UrlPatterns<TEnv, any> | UrlPatternsResolver<TEnv>;

  /**
   * Injected by the Vite transform at compile time.
   * Static import of NamedRoutes from the generated named-routes file.
   * Used to seed reverse() with the full named route map.
   * @internal
   */
  $$routeNames?: Record<string, NamedRouteEntry>;

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
        : { readonly path: TRoutes[K] & string; readonly response: NonNullable<TResponses>[K] }
    : TRoutes[K]
};

/**
 * Extract the URL pattern from a route entry (string or { path, response } object)
 */
type PatternOfEntry<V> =
  V extends string ? V
  : V extends { readonly path: infer P extends string } ? P
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
  [K in keyof TExisting & keyof TNew]: PatternOfEntry<TExisting[K]> extends PatternOfEntry<TNew[K]>
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
   * Register URL patterns lazily via resolver.
   *
   * Useful when avoiding circular imports (for example, pages importing
   * `reverse` from the router module while the router imports `urlpatterns`).
   *
   * @example
   * ```typescript
   * export const router = createRouter<AppEnv>({...})
   *   .routes(() => urlpatterns);
   * ```
   */
  routes<T extends UrlPatterns<TEnv, any>>(
    patterns: () => T | null | undefined,
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
      handler: import("./router/middleware.js").MiddlewareFn;
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
 * // router.reverse now has type-safe autocomplete for all registered routes
 * // Given shopRoutes = { cart: "/cart" }, reverse uses original key:
 * router.reverse("cart"); // "/shop/cart"
 * ```
 */

export function createRouter<TEnv = any>(
  options: RSCRouterOptions<TEnv> = {},
): RSCRouter<TEnv, {}> {
  const {
    id: userProvidedId,
    $$id: injectedId,
    debugPerformance = false,
    document: documentOption,
    defaultErrorBoundary,
    defaultNotFoundBoundary,
    notFound,
    onError,
    cache,
    theme: themeOption,
    urls: urlsOption,
    $$routeNames: staticRouteNames,
    nonce,
    version,
    warmup: warmupOption,
    allowDebugManifest: allowDebugManifestOption = false,
  } = options;

  // Capture the source file that called createRouter() via stack trace parsing.
  // Used by the Vite plugin to write per-router named-routes.gen.ts files.
  let __sourceFile: string | undefined;
  try {
    const stack = new Error().stack;
    if (stack) {
      const lines = stack.split("\n");
      for (const line of lines) {
        const match = line.match(/\((.+?\.(ts|tsx|js|jsx)):\d+:\d+\)/);
        if (match && !match[1].endsWith("/router.ts") && !match[1].includes("@rangojs/router") && !match[1].includes("node_modules")) {
          // Strip file: URL protocol prefix from Vite module runner stack traces
          __sourceFile = match[1].startsWith("file:") ? match[1].slice(5) : match[1];
          break;
        }
      }
    }
  } catch {}

  // Router ID priority: explicit id > Vite-injected $$id > counter fallback.
  // $$id is a hash of filename+line injected by the Vite transform at compile
  // time, so it's stable across build/runtime regardless of module evaluation
  // order (unlike the counter which depends on import order).
  const routerId = userProvidedId ?? injectedId ?? `router_${routerAutoId++}`;

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
  let pendingUrlPatternsResolver: UrlPatternsResolver<TEnv> | null = null;
  let warnedDeferredUrlPatterns = false;

  const isUrlPatternsValue = (value: unknown): value is UrlPatterns<TEnv, any> =>
    typeof value === "object" &&
    value !== null &&
    "handler" in value &&
    "definitions" in value &&
    typeof (value as UrlPatterns<TEnv>).handler === "function";

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

  // Track all registered routes with their prefixes for reverse().
  // Seed from injected NamedRoutes so reverse() works at module load time
  // for routes that come from lazy includes.
  const mergedRouteMap: Record<string, string> = flattenNamedRoutes(staticRouteNames);

  // Lazy precomputed entries lookup: rebuilt when per-router data arrives.
  // In production multi-router setups, per-router data is loaded lazily via
  // ensureRouterManifest(). At createRouter() time the data isn't available yet,
  // so we defer building the Map until first use and invalidate when the
  // per-router source changes.
  let precomputedByPrefix: Map<string, Record<string, string>> | null = null;
  let precomputedSource: Array<{ staticPrefix: string; routes: Record<string, string> }> | null | undefined;

  function getPrecomputedByPrefix(): Map<string, Record<string, string>> | null {
    const current = getRouterPrecomputedEntries(routerId) ?? getPrecomputedEntries();
    if (current !== precomputedSource) {
      precomputedSource = current;
      precomputedByPrefix = current
        ? new Map(current.map((e) => [e.staticPrefix, e.routes]))
        : null;
    }
    return precomputedByPrefix;
  }


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
    // Use per-router manifest when available, otherwise the static named map
    // seeded into mergedRouteMap at router creation.
    getRouteMap: () => getRouterManifest(routerId) ?? mergedRouteMap,
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
    options?: { skipLoaders?: boolean },
  ) {
    return _resolveAllSegments(entries, routeKey, params, context, loaderPromises, segmentDeps, options);
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
    // When multiple entries share the same staticPrefix (e.g., several
    // include("/", ...) calls), the precomputed data merges all their routes
    // into one entry. Assigning that merged set to the first matching entry
    // causes findMatch to pick the wrong handler for routes belonging to a
    // different include. Skip the shortcut when the prefix is shared.
    const currentPrecomputed = getPrecomputedByPrefix();
    if (currentPrecomputed) {
      const routes = currentPrecomputed.get(entry.staticPrefix);
      if (routes) {
        const prefixIsShared = routesEntries.filter(
          (e) => e.staticPrefix === entry.staticPrefix,
        ).length > 1;
        if (!prefixIsShared) {
          entry.lazyEvaluated = true;
          entry.routes = routes as ResolvedRouteMap<any>;
          for (const [name, pattern] of Object.entries(routes)) {
            mergedRouteMap[name] = pattern;
          }
          registerRouteMap(mergedRouteMap);
          return;
        }
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

    // Merge captured counters from include() to maintain consistent
    // shortCode indices with sibling entries from pattern extraction
    const lazyCounters: Record<string, number> = {};
    if (lazyContext && (lazyContext as any).counters) {
      const captured = (lazyContext as any).counters as Record<string, number>;
      for (const [key, value] of Object.entries(captured)) {
        lazyCounters[key] = value;
      }
    }

    RSCRouterContext.run(
      {
        manifest,
        patterns,
        patternsByPrefix,
        trailingSlash: trailingSlashMap,
        namespace: "lazy",
        parent: (lazyContext?.parent as EntryData | null) ?? null,
        counters: lazyCounters,
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
      // Also add to merged route map for reverse() support
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
        mountIndex: mountIndex++,
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

    // Re-register route map for runtime reverse() usage
    registerRouteMap(mergedRouteMap);
  }

  function tryResolveDeferredUrlPatterns(source: string): void {
    if (!pendingUrlPatternsResolver) return;
    if (storedUrlPatterns) {
      pendingUrlPatternsResolver = null;
      warnedDeferredUrlPatterns = false;
      return;
    }

    let resolved: UrlPatterns<TEnv, any> | null | undefined;
    try {
      resolved = pendingUrlPatternsResolver();
    } catch (error) {
      console.warn(
        `[rsc-router] Deferred routes resolver threw in ${source}. ` +
          `Route registration is still pending.`,
        error,
      );
      return;
    }

    if (resolved == null) {
      return;
    }

    if (!isUrlPatternsValue(resolved)) {
      pendingUrlPatternsResolver = null;
      warnedDeferredUrlPatterns = false;
      throw new Error(
        `[rsc-router] Deferred routes resolver returned an invalid value in ${source}. ` +
          `Expected a urls() result with { handler, definitions }.`,
      );
    }

    registerUrlPatterns(resolved);
    pendingUrlPatternsResolver = null;
    warnedDeferredUrlPatterns = false;
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
    if (pendingUrlPatternsResolver && routesEntries.length === 0) {
      tryResolveDeferredUrlPatterns("findMatch");
    }

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
    // Prefer per-router trie (isolated) over global trie (merged).
    const routeTrie = getRouterTrie(routerId) ?? getRouteTrie();
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
            ...(trieResult.negotiateVariants ? { negotiateVariants: trieResult.negotiateVariants } : {}),
            ...(trieResult.rscFirst ? { rscFirst: true } : {}),
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
   * Build-time pre-render match. Resolves segments with a BuildContext
   * (no request/env/headers/cookies), skipping middleware and loaders.
   */
  async function matchForPrerender(
    pathname: string,
    params: Record<string, string>,
  ): Promise<{
    segments: SerializedSegmentData[];
    handles: Record<string, SegmentHandleData>;
    routeName: string;
    params: Record<string, string>;
    interceptSegments?: SerializedSegmentData[];
    interceptHandles?: Record<string, SegmentHandleData>;
  } | null> {
    // 1. Find the matching route entry
    const matched = findMatch(pathname);
    if (!matched) return null;

    // Use params from trie match if available, fall back to provided params
    const matchedParams = matched.params ?? params;

    // Build a minimal RouterContext for loadManifest/traverseBack
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
      // 2. Load the manifest entry tree
      const manifestEntry = await loadManifest(
        matched.entry,
        matched.routeKey,
        pathname,
        undefined,
        false,
      );

      // 3. Build ancestor chain [root, ..., route]
      const entries: EntryData[] = [];
      for (const entry of traverseBack(manifestEntry)) {
        entries.push(entry);
      }

      // 4. Create handle store for collecting handle data
      const handleStore = createHandleStore();

      // 5. Create a minimal request context with the handle store
      const stubRes = new Response(null, { status: 200 });
      const minimalRequestContext: RequestContext<TEnv> = {
        env: {} as TEnv,
        request: new Request("http://prerender" + pathname),
        url: new URL("http://prerender" + pathname),
        pathname,
        searchParams: new URLSearchParams(),
        var: {},
        get: () => undefined as any,
        set: () => {},
        params: matchedParams,
        res: stubRes,
        cookie: () => undefined,
        cookies: () => ({}),
        setCookie: () => {},
        deleteCookie: () => {},
        header: () => {},
        use: (() => {
          throw new Error("use() not available during pre-rendering");
        }) as any,
        method: "GET",
        _handleStore: handleStore,
        waitUntil: () => {},
        onResponse: () => {},
        _onResponseCallbacks: [],
        setLocationState() {},
        _locationState: undefined,
      };

      return runWithRequestContext(minimalRequestContext, async () => {
        // 6. Create prerender context with synthetic URL.
        // Prerender handlers get params, pathname, url, searchParams, search,
        // reverse, and use(handle) — but no request, env, headers, or cookies.
        const buildCtx = createPrerenderContext<TEnv>(
          matchedParams,
          pathname,
          mergedRouteMap,
          matched.routeKey,
        );

        // 7. Wire use() for handles only (loaders throw)
        setupBuildUse(buildCtx);

        // 8. Resolve all segments with skipLoaders
        const loaderPromises = new Map<string, Promise<any>>();
        const allSegments = await resolveAllSegments(
          entries,
          matched.routeKey,
          matchedParams,
          buildCtx,
          loaderPromises,
          { skipLoaders: true },
        );

        // 9. Filter out any loader segments (belt-and-suspenders)
        const nonLoaderSegments = allSegments.filter((s) => s.type !== "loader");

        // 10. Wait for handles to settle
        await handleStore.settled;

        // 11. Serialize segments using the cache serializer
        const { serializeSegments } = await import("./cache/segment-codec.js");
        const serializedSegments = await serializeSegments(nonLoaderSegments);

        // 12. Collect handle data per segment (skip segments with no handle data)
        const handles: Record<string, SegmentHandleData> = {};
        for (const seg of nonLoaderSegments) {
          const segHandles = handleStore.getDataForSegment(seg.id);
          if (Object.keys(segHandles).length > 0) {
            handles[seg.id] = segHandles;
          }
        }

        // Use the trie-level route key (e.g., "docs", "docs.article")
        const routeName = matched.routeKey;

        // 13. Resolve intercept segments for this route (if any ancestor defines
        //     an intercept targeting this route). At build time we skip when()
        //     evaluation -- we pre-render all intercepts unconditionally and let
        //     runtime matching decide which to serve.
        let interceptSegments: SerializedSegmentData[] | undefined;
        let interceptHandles: Record<string, SegmentHandleData> | undefined;

        const foundIntercepts: { intercept: InterceptEntry; entry: EntryData }[] = [];
        let current: EntryData | null = manifestEntry;
        while (current) {
          if (current.intercept && current.intercept.length > 0) {
            for (const ic of current.intercept) {
              if (ic.routeName === matched.routeKey) {
                foundIntercepts.push({ intercept: ic, entry: current });
              }
            }
          }
          if (current.layout && current.layout.length > 0) {
            for (const siblingLayout of current.layout) {
              if (siblingLayout.intercept && siblingLayout.intercept.length > 0) {
                for (const ic of siblingLayout.intercept) {
                  if (ic.routeName === matched.routeKey) {
                    foundIntercepts.push({ intercept: ic, entry: siblingLayout });
                  }
                }
              }
            }
          }
          current = current.parent;
        }

        if (foundIntercepts.length > 0) {
          const interceptResolvedSegments: typeof nonLoaderSegments = [];

          for (const { intercept, entry: parentEntry } of foundIntercepts) {
            // Resolve handler
            const handlerRaw =
              typeof intercept.handler === "function"
                ? intercept.handler(buildCtx)
                : intercept.handler;
            const handlerResolved =
              handlerRaw instanceof Promise ? await handlerRaw : handlerRaw;
            if (handlerResolved instanceof Response) {
              // Handler returned a redirect/response -- skip this intercept
              continue;
            }
            const component: ReactNode = handlerResolved;

            // Resolve layout (if any)
            let layoutElement: ReactNode | undefined;
            if (intercept.layout) {
              if (typeof intercept.layout === "function") {
                const layoutResult = await intercept.layout(buildCtx);
                if (layoutResult instanceof Response) continue;
                layoutElement = layoutResult;
              } else {
                layoutElement = intercept.layout;
              }
            }

            interceptResolvedSegments.push({
              id: `${parentEntry.shortCode}.${intercept.slotName}`,
              namespace: `intercept:${intercept.routeName}`,
              type: "parallel" as const,
              index: 0,
              component,
              loading: intercept.loading === false ? null : intercept.loading,
              layout: layoutElement,
              params: matchedParams,
              slot: intercept.slotName,
              belongsToRoute: true,
              parallelName: `intercept:${intercept.routeName}.${intercept.slotName}`,
            });
          }

          if (interceptResolvedSegments.length > 0) {
            // Wait for handles again (intercept handlers may have called use())
            await handleStore.settled;
            interceptSegments = await serializeSegments(interceptResolvedSegments);
            interceptHandles = {};
            for (const seg of interceptResolvedSegments) {
              const segHandles = handleStore.getDataForSegment(seg.id);
              if (Object.keys(segHandles).length > 0) {
                interceptHandles[seg.id] = segHandles;
              }
            }
          }
        }

        return {
          segments: serializedSegments,
          handles,
          routeName,
          params: matchedParams,
          interceptSegments,
          interceptHandles,
        };
      });
    });
  }

  /**
   * Render a single Static handler at build time.
   * Creates a minimal BuildContext, calls the handler, and RSC-serializes
   * the component. Returns the encoded Flight string (or null on failure).
   * Used by the Vite plugin to collect static segment data at build time.
   */
  async function renderStaticSegment(
    handler: Function,
    handlerId: string,
  ): Promise<{ encoded: string; handles: Record<string, unknown[]> } | null> {
    const syntheticUrl = new URL("http://prerender/");
    const syntheticRequest = new Request(syntheticUrl);

    // Create a HandleStore to capture handle data pushed during rendering
    const handleStore = createHandleStore();

    // Minimal request context so setupBuildUse can find the HandleStore
    const stubRes = new Response(null, { status: 200 });
    const minimalRequestContext: RequestContext<TEnv> = {
      env: {} as TEnv,
      request: syntheticRequest,
      url: syntheticUrl,
      pathname: "/",
      searchParams: syntheticUrl.searchParams,
      var: {},
      get: () => undefined as any,
      set: () => {},
      params: {},
      res: stubRes,
      cookie: () => undefined,
      cookies: () => ({}),
      setCookie: () => {},
      deleteCookie: () => {},
      header: () => {},
      use: (() => {
        throw new Error("use() not available during static pre-rendering");
      }) as any,
      method: "GET",
      _handleStore: handleStore,
      waitUntil: () => {},
      onResponse: () => {},
      _onResponseCallbacks: [],
      setLocationState() {},
      _locationState: undefined,
    };

    return runWithRequestContext(minimalRequestContext, async () => {
      // Static handlers get only reverse and use(handle) — no URL, params,
      // request, env, headers, or cookies.
      const buildCtx = createStaticContext<TEnv>(
        mergedRouteMap,
      );

      // Set segment ID so handle pushes are keyed correctly
      (buildCtx as InternalHandlerContext)._currentSegmentId = handlerId;

      setupBuildUse(buildCtx);

      const raw = await handler(buildCtx);
      const component = raw?.type ? raw : raw;

      const segment: ResolvedSegment = {
        id: handlerId,
        namespace: handlerId,
        type: "layout",
        index: 0,
        component,
        params: {},
        belongsToRoute: false,
      };

      const { serializeSegments } = await import("./cache/segment-codec.js");
      const [serialized] = await serializeSegments([segment]);

      // Collect handle data pushed during rendering
      const handles = handleStore.getDataForSegment(handlerId);

      return { encoded: serialized.encoded, handles };
    });
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

    return runWithRouterLogContext(
      { request, transaction: "match" },
      () =>
        runWithRouterContext(routerCtx, async () =>
          withRouterLogScope("match", async () => {
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
          }),
        ),
    );
  }

  async function matchError(
    request: Request,
    _context: TEnv,
    error: unknown,
    segmentType: ErrorInfo["segmentType"] = "route",
  ): Promise<MatchResult | null> {
    return runWithRouterLogContext(
      { request, transaction: "matchError" },
      () =>
        withRouterLogScope("matchError", () =>
          _matchError(
            request,
            _context,
            error,
            matchApiDeps,
            defaultErrorBoundary,
            segmentType,
          ),
        ),
    );
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

    return runWithRouterLogContext(
      { request, transaction: "matchPartial" },
      () =>
        runWithRouterContext(routerCtx, async () =>
          withRouterLogScope("matchPartial", async () => {
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
          }),
        ),
    );
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
    negotiated?: boolean;
    manifestEntry?: EntryData;
  } | null> {
    return runWithRouterLogContext(
      { request, transaction: "previewMatch" },
      async () =>
        withRouterLogScope("previewMatch", async () => {
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

    // Content negotiation: when negotiate variants exist, pick the best
    // handler based on the Accept header. Uses q-values and client order
    // as tiebreaker (matching Express/Hono behavior). RSC routes participate
    // as text/html candidates so browsers naturally get HTML without
    // special-casing.
    if (matched.negotiateVariants && matched.negotiateVariants.length > 0) {
      const acceptEntries = parseAcceptTypes(request.headers.get("accept") || "");

      // Build candidate list preserving definition order.
      // For wildcard (*/*) and no-Accept fallback, the first candidate wins.
      const variants = matched.negotiateVariants;
      let candidates: Array<{ routeKey: string; responseType: string }>;
      if (responseType) {
        // Primary is response-type — include it as a candidate
        candidates = [...variants, { routeKey: matched.routeKey, responseType }];
      } else {
        // Primary is RSC — insert as text/html candidate in definition order
        const rscCandidate = { routeKey: matched.routeKey, responseType: RSC_RESPONSE_TYPE };
        candidates = matched.rscFirst
          ? [rscCandidate, ...variants]
          : [...variants, rscCandidate];
      }

      const variant = pickNegotiateVariant(acceptEntries, candidates);

      // If the winner is RSC, fall through to default RSC handling
      if (variant.responseType === RSC_RESPONSE_TYPE) {
        // Fall through — RSC won negotiation
      } else if (responseType && variant.routeKey === matched.routeKey) {
        // Fall through — response-type primary won, already set
      } else {
        const negotiateEntry = await loadManifest(
          matched.entry,
          variant.routeKey,
          pathname,
          undefined,
          false,
        );
        return {
          routeMiddleware: routeMiddleware.length > 0 ? routeMiddleware : undefined,
          responseType: variant.responseType,
          handler: negotiateEntry.type === "route" ? negotiateEntry.handler : undefined,
          params: matched.params,
          negotiated: true,
          manifestEntry: negotiateEntry,
        };
      }
    }

    // If we passed through the negotiation block (variants exist), mark as
    // negotiated so the handler sets Vary: Accept on the response.
          const hasVariants = matched.negotiateVariants && matched.negotiateVariants.length > 0;
          return {
            routeMiddleware: routeMiddleware.length > 0 ? routeMiddleware : undefined,
            params: matched.params,
            ...(responseType ? {
              responseType,
              handler: manifestEntry.type === "route" ? manifestEntry.handler : undefined,
              manifestEntry,
            } : {}),
            ...(hasVariants ? { negotiated: true } : {}),
          };
        }),
    );
  }

  function registerUrlPatterns(
    urlPatterns: UrlPatterns<TEnv, any>,
  ): RSCRouter<TEnv, {}> {
    // Store reference for runtime manifest generation
    storedUrlPatterns = urlPatterns;
    const currentMountIndex = mountIndex++;

    // Create manifest and patterns maps for route registration
    const manifest = new Map<string, EntryData>();
    const patterns = new Map<string, string>();
    const patternsByPrefix = new Map<string, Map<string, string>>();
    const trailingSlashMap = new Map<string, TrailingSlashMode>();

    // Run the handler once to extract patterns for route matching.
    // Note: loadManifest will re-run the handler to register entries in its context.
    // Lazy includes are detected in the return value and handled separately.
    //
    // Pattern extraction must use the same mountIndex and MapRootLayout root
    // parent as loadManifest so that shortCodes produced here match those at
    // runtime. include() captures the current parent and counters; if those
    // shortCodes diverge from the runtime tree the segment reconciliation on
    // the client will see a full mismatch and remount the entire page.
    const syntheticMapRoot: EntryData = {
      type: "layout",
      id: `#synthetic-maproot-M${currentMountIndex}`,
      shortCode: `M${currentMountIndex}L0`,
      parent: null,
      handler: MapRootLayout,
      middleware: [],
      revalidate: [],
      errorBoundary: [],
      notFoundBoundary: [],
      layout: [],
      parallel: [],
      intercept: [],
      loader: [],
    };

    let handlerResult: AllUseItems[] = [];
    RSCRouterContext.run(
      {
        manifest,
        patterns,
        patternsByPrefix,
        trailingSlash: trailingSlashMap,
        namespace: "root",
        parent: syntheticMapRoot,
        counters: {},
        mountIndex: currentMountIndex,
      },
      () => {
        handlerResult = urlPatterns.handler() as AllUseItems[];
      },
    );

    // Store the ORIGINAL handler - loadManifest will re-run it to register manifest entries
    // Convert trailingSlash map to object for the router
    const trailingSlashConfig =
      trailingSlashMap.size > 0
        ? Object.fromEntries(trailingSlashMap)
        : undefined;

    // Collect route keys that have prerender handlers (for non-trie match path)
    let prerenderRouteKeys: Set<string> | undefined;
    for (const [name, entry] of manifest.entries()) {
      if (entry.type === "route" && entry.isPrerender) {
        if (!prerenderRouteKeys) prerenderRouteKeys = new Set();
        prerenderRouteKeys.add(name);
      }
    }

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
          ...(prerenderRouteKeys ? { prerenderRouteKeys } : {}),
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
        ...(prerenderRouteKeys ? { prerenderRouteKeys } : {}),
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
        mountIndex: mountIndex++,
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

    // Auto-register route map for runtime reverse() usage
    registerRouteMap(mergedRouteMap);

    return router as RSCRouter<TEnv, {}>;
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

    // Merge routes into the reverse map
    // Keys stay unchanged for composability - only URL patterns get prefixed
    if (routes == null) {
      throw new Error(
        `[rsc-router] createRouteBuilder received null/undefined routes for prefix "${prefix}". ` +
        `This is an invariant violation — the route builder callback must return a Record<string, string>.`,
      );
    }
    const routeEntries = routes as Record<string, string>;
    for (const [key, pattern] of Object.entries(routeEntries)) {
      // Build prefixed pattern: "/shop" + "/cart" -> "/shop/cart"
      // Root prefix "/" is a no-op — don't double the leading slash.
      const effectivePrefix = prefix === "/" ? "" : prefix;
      const prefixedPattern =
        effectivePrefix && pattern !== "/"
          ? `${effectivePrefix}${pattern}`
          : effectivePrefix && pattern === "/"
            ? effectivePrefix
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

    // Auto-register route map for runtime reverse() usage
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
      prefixOrRoutes:
        | string
        | Record<string, string>
        | UrlPatterns<TEnv>
        | UrlPatternsResolver<TEnv>,
      maybeRoutes?: Record<string, string>,
    ): any {
      // Note: Multiple .routes() calls are allowed for backwards compatibility
      // with the old map() pattern. For new code, prefer urls() with include().

      if (typeof prefixOrRoutes === "function" && maybeRoutes === undefined) {
        const resolver = prefixOrRoutes as UrlPatternsResolver<TEnv>;
        const resolved = resolver();
        if (resolved == null) {
          pendingUrlPatternsResolver = resolver;
          if (!warnedDeferredUrlPatterns) {
            warnedDeferredUrlPatterns = true;
            console.warn(
              `[rsc-router] routes() resolver returned null/undefined during initialization. ` +
                `Deferring route registration until first match/request.`,
            );
          }
          return router;
        }
        if (!isUrlPatternsValue(resolved)) {
          throw new Error(
            `[rsc-router] routes() resolver must return a urls() result. ` +
              `Received ${typeof resolved}.`,
          );
        }
        pendingUrlPatternsResolver = null;
        warnedDeferredUrlPatterns = false;
        return registerUrlPatterns(resolved);
      }

      // Check if argument is UrlPatterns (new Django-style API)
      if (isUrlPatternsValue(prefixOrRoutes)) {
        pendingUrlPatternsResolver = null;
        warnedDeferredUrlPatterns = false;
        return registerUrlPatterns(prefixOrRoutes);
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
    // Seeded with static route names from the generated file (injected by Vite)
    reverse: createReverse(mergedRouteMap),

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
    matchForPrerender,
    renderStaticSegment,
    matchPartial,
    matchError,
    previewMatch,

    // Expose nonce provider for fetch
    nonce,

    // Expose version for fetch
    version,

    // Expose urlpatterns for runtime manifest generation
    get urlpatterns() {
      if (!storedUrlPatterns && pendingUrlPatternsResolver) {
        tryResolveDeferredUrlPatterns("router.urlpatterns");
      }
      return storedUrlPatterns ?? undefined;
    },

    // Expose source file for per-router type generation
    __sourceFile,

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
        if (!storedUrlPatterns && pendingUrlPatternsResolver) {
          tryResolveDeferredUrlPatterns("fetch");
        }

        // Trigger lazy import of per-router manifest data before route matching.
        // No-op if data is already loaded or no loader is registered.
        await ensureRouterManifest(routerId);
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
      if (!storedUrlPatterns && pendingUrlPatternsResolver) {
        tryResolveDeferredUrlPatterns("debugManifest");
      }

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
    if (typeof urlsOption === "function") {
      return router.routes(urlsOption as UrlPatternsResolver<TEnv>) as RSCRouter<TEnv, {}>;
    }
    return router.routes(urlsOption as UrlPatterns<TEnv, any>) as RSCRouter<TEnv, {}>;
  }

  return router;
}
