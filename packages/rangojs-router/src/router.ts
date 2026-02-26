import { type ReactNode } from "react";
import { createCacheScope } from "./cache/cache-scope.js";
import { setCacheProfiles } from "./cache/profile-registry.js";
import { isCachedFunction } from "./cache/taint.js";
import { assertClientComponent } from "./component-utils.js";
import { DefaultDocument } from "./components/DefaultDocument.js";
import { sanitizeError } from "./errors";
import { serializeManifest, type SerializedManifest } from "./debug.js";
import {
  createReverse,
  type ReverseFunction,
  type PrefixRoutePatterns,
} from "./reverse.js";
import {
  registerRouteMap,
  getPrecomputedEntries,
  getRouterManifest,
  getRouterPrecomputedEntries,
  ensureRouterManifest,
} from "./route-map-builder.js";
import { createRouteHelpers, type RouteHandlers } from "./route-definition.js";
import MapRootLayout from "./server/root-layout.js";
import type { AllUseItems } from "./route-types.js";
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
  ErrorInfo,
  ErrorPhase,
  HandlerContext,
  LoaderDataResult,
  MatchResult,
  ResolvedRouteMap,
  RouteDefinition,
  RouteEntry,
  TrailingSlashMode,
} from "./types";
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
import { createMetricsStore } from "./router/metrics.js";
import {
  parsePattern,
  type MiddlewareEntry,
  type MiddlewareFn,
} from "./router/middleware.js";
import {
  extractStaticPrefix,
  traverseBack,
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

// Extracted content negotiation utilities
import { flattenNamedRoutes } from "./router/content-negotiation.js";

// Extracted router types and registry
import {
  RSC_ROUTER_BRAND,
  RouterRegistry,
  nextRouterAutoId,
} from "./router/router-registry.js";
import type {
  RSCRouterOptions,
  RootLayoutProps,
} from "./router/router-options.js";
import type {
  RSCRouter,
  RouteBuilder,
  InlineRouteHelpers,
} from "./router/router-interfaces.js";

// Extracted closure functions
import {
  findLazyIncludes,
  evaluateLazyEntry as _evaluateLazyEntry,
  type LazyEvalDeps,
} from "./router/lazy-includes.js";
import { createFindMatch } from "./router/find-match.js";
import {
  matchForPrerender as _matchForPrerender,
  renderStaticSegment as _renderStaticSegment,
} from "./router/prerender-match.js";
import { previewMatch as _previewMatch } from "./router/preview-match.js";

// Re-export public types and values from extracted modules
export { RSC_ROUTER_BRAND, RouterRegistry } from "./router/router-registry.js";
export type {
  RSCRouterOptions,
  RootLayoutProps,
} from "./router/router-options.js";
export type { RSCRouter } from "./router/router-interfaces.js";

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
    cacheProfiles: cacheProfilesOption,
    theme: themeOption,
    urls: urlsOption,
    $$routeNames: staticRouteNames,
    nonce,
    version,
    warmup: warmupOption,
    allowDebugManifest: allowDebugManifestOption = false,
  } = options;

  // Set cache profiles for "use cache" directive
  if (cacheProfilesOption) {
    setCacheProfiles(cacheProfilesOption);
  }

  // Capture the source file that called createRouter() via stack trace parsing.
  // Used by the Vite plugin to write per-router named-routes.gen.ts files.
  let __sourceFile: string | undefined;
  try {
    const stack = new Error().stack;
    if (stack) {
      const lines = stack.split("\n");
      for (const line of lines) {
        const match = line.match(/\((.+?\.(ts|tsx|js|jsx)):\d+:\d+\)/);
        if (
          match &&
          !match[1].endsWith("/router.ts") &&
          !match[1].includes("@rangojs/router") &&
          !match[1].includes("node_modules")
        ) {
          // Strip file: URL protocol prefix from Vite module runner stack traces
          __sourceFile = match[1].startsWith("file:")
            ? match[1].slice(5)
            : match[1];
          break;
        }
      }
    }
  } catch {}

  // Router ID priority: explicit id > Vite-injected $$id > counter fallback.
  // $$id is a hash of filename+line injected by the Vite transform at compile
  // time, so it's stable across build/runtime regardless of module evaluation
  // order (unlike the counter which depends on import order).
  const routerId =
    userProvidedId ?? injectedId ?? `router_${nextRouterAutoId()}`;

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

    // Prevent "use cache" functions from being used as middleware.
    // They return data/JSX and do not call next() — silently accepting
    // them would be a confusing no-op.
    if (isCachedFunction(handler)) {
      throw new Error(
        `A "use cache" function cannot be used as middleware. ` +
          `Cached functions return data and do not participate in the ` +
          `middleware chain. Remove the "use cache" directive or use a ` +
          `regular middleware function instead.`,
      );
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
  const mergedRouteMap: Record<string, string> =
    flattenNamedRoutes(staticRouteNames);

  // Lazy precomputed entries lookup: rebuilt when per-router data arrives.
  // In production multi-router setups, per-router data is loaded lazily via
  // ensureRouterManifest(). At createRouter() time the data isn't available yet,
  // so we defer building the Map until first use and invalidate when the
  // per-router source changes.
  let precomputedByPrefix: Map<string, Record<string, string>> | null = null;
  let precomputedSource:
    | Array<{ staticPrefix: string; routes: Record<string, string> }>
    | null
    | undefined;

  function getPrecomputedByPrefix(): Map<
    string,
    Record<string, string>
  > | null {
    const current =
      getRouterPrecomputedEntries(routerId) ?? getPrecomputedEntries();
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
    return _resolveAllSegments(
      entries,
      routeKey,
      params,
      context,
      loaderPromises,
      segmentDeps,
      options,
    );
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
    actionContext?: {
      actionId?: string;
      actionUrl?: URL;
      actionResult?: any;
      formData?: FormData;
    },
  ) {
    return _resolveLoadersOnlyWithRevalidation(
      entries,
      context,
      clientSegmentIds,
      prevParams,
      request,
      prevUrl,
      nextUrl,
      routeKey,
      segmentDeps,
      actionContext,
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
    actionContext:
      | {
          actionId?: string;
          actionUrl?: URL;
          actionResult?: any;
          formData?: FormData;
        }
      | undefined,
    interceptResult: { intercept: InterceptEntry; entry: EntryData } | null,
    localRouteName: string,
    pathname: string,
  ) {
    return _resolveAllSegmentsWithRevalidation(
      entries,
      routeKey,
      params,
      context,
      clientSegmentSet,
      prevParams,
      request,
      prevUrl,
      nextUrl,
      loaderPromises,
      actionContext,
      interceptResult,
      localRouteName,
      pathname,
      segmentDeps,
    );
  }

  function findInterceptForRoute(
    targetRouteKey: string,
    fromEntry: EntryData | null,
    selectorContext: InterceptSelectorContext | null = null,
    isAction: boolean = false,
  ) {
    return _findInterceptForRoute(
      targetRouteKey,
      fromEntry,
      selectorContext,
      isAction,
    );
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
      interceptEntry,
      parentEntry,
      params,
      context,
      belongsToRoute,
      segmentDeps,
      revalidationContext,
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
      interceptEntry,
      parentEntry,
      params,
      context,
      belongsToRoute,
      segmentDeps,
      revalidationContext,
    );
  }

  // Lazy evaluation deps — captures closure state for extracted evaluateLazyEntry
  const lazyEvalDeps: LazyEvalDeps<TEnv> = {
    routesEntries,
    mergedRouteMap,
    nextMountIndex: () => mountIndex++,
    getPrecomputedByPrefix,
  };

  function evaluateLazyEntry(entry: RouteEntry<TEnv>): void {
    _evaluateLazyEntry(entry, lazyEvalDeps);
  }

  // Create findMatch with single-entry cache, bound to router state
  const findMatch = createFindMatch<TEnv>({
    routesEntries,
    evaluateLazyEntry,
    routerId,
  });

  // Build a RouterContext once — shared by match, matchPartial, matchForPrerender
  function buildRouterContext(): RouterContext<TEnv> {
    return {
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
  }

  // Prerender/static match deps (bind closure state for extracted functions)
  const prerenderDeps = {
    findMatch,
    buildRouterContext,
    mergedRouteMap,
    resolveAllSegments,
  };

  async function matchForPrerender(
    pathname: string,
    params: Record<string, string>,
    buildVars?: Record<string, any>,
  ) {
    return _matchForPrerender(pathname, params, prerenderDeps, buildVars);
  }

  async function renderStaticSegment(
    handler: Function,
    handlerId: string,
    routeName?: string,
  ) {
    return _renderStaticSegment<TEnv>(
      handler,
      handlerId,
      mergedRouteMap,
      routeName,
    );
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
    return runWithRouterLogContext({ request, transaction: "match" }, () =>
      runWithRouterContext(buildRouterContext(), async () =>
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
    return runWithRouterLogContext({ request, transaction: "matchError" }, () =>
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

  async function createMatchContextForFull(request: Request, env: TEnv) {
    return _createMatchContextForFull(
      request,
      env,
      matchApiDeps,
      findInterceptForRoute,
    );
  }

  async function createMatchContextForPartial(
    request: Request,
    env: TEnv,
    actionContext?: {
      actionId?: string;
      actionUrl?: URL;
      actionResult?: any;
      formData?: FormData;
    },
  ) {
    return _createMatchContextForPartial(
      request,
      env,
      matchApiDeps,
      findInterceptForRoute,
      actionContext,
    );
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
    return runWithRouterLogContext(
      { request, transaction: "matchPartial" },
      () =>
        runWithRouterContext(buildRouterContext(), async () =>
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

  async function previewMatch(request: Request, _context: TEnv) {
    return _previewMatch(request, _context, { findMatch });
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

        // Run the handler once to extract patterns for route matching.
        // Note: loadManifest will re-run the handler to register entries in its context.
        // Lazy includes are detected in the return value and handled separately.
        //
        // Pattern extraction must use the same mountIndex and MapRootLayout root
        // parent as loadManifest so that shortCodes produced here match those at
        // runtime.  include() captures the current parent and counters; if those
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
