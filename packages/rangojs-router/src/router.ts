import { type ReactNode } from "react";
import { createCacheScope } from "./cache/cache-scope.js";
import { resolveCacheProfiles } from "./cache/profile-registry.js";
import { isCachedFunction } from "./cache/taint.js";
import { assertClientComponent } from "./component-utils.js";
import { DefaultDocument } from "./components/DefaultDocument.js";
import type { SerializedManifest } from "./debug.js";
import { createReverse, type ReverseFunction } from "./reverse.js";
import {
  registerRouteMap,
  getRouterManifest,
  getRouterPrecomputedEntries,
  ensureRouterManifest,
} from "./route-map-builder.js";
import MapRootLayout from "./server/root-layout.js";
import type { AllUseItems } from "./route-types.js";
import type { UrlPatterns } from "./urls.js";
import type { UrlBuilder } from "./urls/pattern-types.js";
import { urls } from "./urls.js";
import { buildPrecomputedByPrefix } from "./build/prefix-tree-utils.js";
import {
  type EntryData,
  getContext,
  RangoContext,
  type MetricsStore,
} from "./server/context";
import { createHandleStore, type HandleStore } from "./server/handle-store.js";
import {
  getRequestContext,
  _getRequestContext,
} from "./server/request-context.js";
import type {
  ErrorPhase,
  HandlerContext,
  LoaderDataResult,
  ResolvedRouteMap,
  RouteEntry,
  TrailingSlashMode,
} from "./types";

// Extracted router utilities
import {
  createErrorInfo,
  findNearestErrorBoundary as findErrorBoundary,
  findNearestNotFoundBoundary as findNotFoundBoundary,
  invokeOnError,
} from "./router/error-handling.js";

// Extracted module factories
import { createSegmentWrappers } from "./router/segment-wrappers.js";
import { createMatchHandlers } from "./router/match-handlers.js";
import { buildDebugManifest } from "./router/debug-manifest.js";

import type { SegmentResolutionDeps, MatchApiDeps } from "./router/types.js";
import { createHandlerContext } from "./router/handler-context.js";
import { normalizeBasename } from "./router/basename.js";
import {
  setupLoaderAccess,
  setupLoaderAccessSilent,
  wrapLoaderWithErrorHandling,
} from "./router/loader-resolution.js";
import { loadManifest } from "./router/manifest.js";
import { createMetricsStore } from "./router/metrics.js";
import {
  compileMiddlewarePattern,
  type MiddlewareEntry,
  type MiddlewareFn,
} from "./router/middleware.js";
import {
  extractStaticPrefix,
  joinPrefix,
  traverseBack,
} from "./router/pattern-matching.js";
import { resolveSink, safeEmit, getRequestId } from "./router/telemetry.js";
import { resolveTracing } from "./router/tracing.js";
import { evaluateRevalidation } from "./router/revalidation.js";
import {
  type RouterContext,
  runWithRouterContext,
} from "./router/router-context.js";
import { resolveThemeConfig } from "./theme/constants.js";
import { resolveTimeouts } from "./router/timeout.js";

// Extracted content negotiation utilities
import { flattenNamedRoutes } from "./router/content-negotiation.js";

// Extracted router types and registry
import {
  RSC_ROUTER_BRAND,
  RouterRegistry,
  nextRouterAutoId,
} from "./router/router-registry.js";
import type { RangoOptions, RootLayoutProps } from "./router/router-options.js";
import type {
  Rango,
  RangoInternal,
  RouterRequestInput,
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
import { resolveStateCookieName } from "./router/state-cookie-name.js";
import { resolvePrefetchCacheTTL } from "./router/prefetch-cache-ttl.js";
import {
  resolvePrefetchCacheSize,
  resolvePrefetchConcurrency,
} from "./router/prefetch-limits.js";

// Re-export public types and values from extracted modules
export { RSC_ROUTER_BRAND, RouterRegistry } from "./router/router-registry.js";
export type {
  RangoOptions,
  RootLayoutProps,
  SSRStreamMode,
  SSROptions,
  ResolveStreamingContext,
} from "./router/router-options.js";
export type {
  Rango,
  RangoInternal,
  RouterRequestInput,
} from "./router/router-interfaces.js";
export { toInternal } from "./router/router-interfaces.js";

export function createRouter<TEnv = any>(
  options: RangoOptions<TEnv> = {},
): Rango<TEnv, {}> {
  const {
    id: userProvidedId,
    $$id: injectedId,
    basename: basenameOption,
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
    $$sourceFile: injectedSourceFile,
    nonce,
    version,
    prefetchCacheTTL: prefetchCacheTTLOption,
    prefetchCacheSize: prefetchCacheSizeOption,
    prefetchConcurrency: prefetchConcurrencyOption,
    stateCookiePrefix: stateCookiePrefixOption,
    warmup: warmupOption,
    telemetry: telemetrySink,
    tracing: tracingOption,
    ssr: ssrOption,
    timeout: timeoutShorthand,
    timeouts: timeoutsOption,
    onTimeout,
    originCheck: originCheckOption,
    viewTransition: viewTransitionOption = "auto",
    debugCacheSignal: debugCacheSignalOption = false,
    debugShellCapture: debugShellCaptureOption,
    strictMode: strictModeOption = true,
  } = options;

  // Debug cache signal gate (DEVELOPMENT/TEST ONLY). Enabled by the
  // debugCacheSignal option OR the RANGO_TEST_SIGNALS=1 env flag. When off,
  // no X-Rango-Cache header is emitted and output is byte-identical.
  const cacheSignalEnabled =
    debugCacheSignalOption ||
    (typeof process !== "undefined" &&
      (process as { env?: Record<string, string | undefined> }).env
        ?.RANGO_TEST_SIGNALS === "1");

  // Normalize basename: ensure leading slash, strip trailing slash.
  // A bare "/" is equivalent to no basename. Shared with the testing
  // primitives via normalizeBasename so they can never drift.
  const basename = normalizeBasename(basenameOption);

  // Resolve telemetry sink (no-op when not configured)
  const telemetry = resolveSink(telemetrySink);

  // Resolve span tracing (undefined when not configured; every traceSpan() call
  // is then a direct pass-through with zero behavior change).
  const resolvedTracing = resolveTracing(tracingOption);

  // Resolve cache profiles: merge user config with the guaranteed default
  // profile. This resolved map is threaded onto each request context; the
  // "use cache: <profile>" runtime path reads it request-scoped.
  const resolvedCacheProfiles = resolveCacheProfiles(cacheProfilesOption);

  // Source file: prefer Vite-injected path (zero cost), fall back to
  // stack trace parsing for non-Vite environments (e.g. tests).
  let __sourceFile: string | undefined = injectedSourceFile;
  if (!__sourceFile) {
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
            __sourceFile = match[1].startsWith("file:")
              ? match[1].slice(5)
              : match[1];
            break;
          }
        }
      }
    } catch {}
  }

  // Router ID priority: explicit id > Vite-injected $$id > counter fallback.
  // $$id is a hash of filename+line injected by the Vite transform at compile
  // time, so it's stable across build/runtime regardless of module evaluation
  // order (unlike the counter which depends on import order).
  const routerId =
    userProvidedId ?? injectedId ?? `router_${nextRouterAutoId()}`;

  // Resolve the rango state cookie name once, here, so the two cookie writers
  // (the client document.cookie writer and the server Set-Cookie writer)
  // consume one pre-composed name and cannot drift.
  const resolvedStateCookieName = resolveStateCookieName(
    stateCookiePrefixOption,
    routerId,
  );

  // Resolve prefetch cache TTL (default: 300 seconds / 5 minutes). Clamps to a
  // non-negative integer and guards non-finite (NaN/Infinity) inputs so a
  // malformed `Cache-Control: max-age=NaN` can never reach the wire.
  const resolvedPrefetchCacheTTL = resolvePrefetchCacheTTL(
    prefetchCacheTTLOption,
  );
  const prefetchCacheTTL = resolvedPrefetchCacheTTL.ms;
  const prefetchCacheControl: string | false =
    resolvedPrefetchCacheTTL.cacheControl;

  // Resolve client-side prefetch limits (in-memory cache size and queue
  // concurrency). Both are positive-integer counts; sub-1/non-finite inputs
  // fall back to the defaults. Shipped to the client in payload metadata.
  const prefetchCacheSize = resolvePrefetchCacheSize(prefetchCacheSizeOption);
  const prefetchConcurrency = resolvePrefetchConcurrency(
    prefetchConcurrencyOption,
  );

  // Resolve warmup enabled flag (default: true)
  const warmupEnabled = warmupOption !== false;

  // Resolve StrictMode flag (default: true). Shipped to the client in payload
  // metadata; the browser entry reads it once to decide whether to wrap the
  // hydrated tree in React.StrictMode.
  const strictMode = strictModeOption !== false;

  // Resolve theme config (null if theme not enabled)
  const resolvedThemeConfig = themeOption
    ? resolveThemeConfig(themeOption)
    : null;

  // Resolve timeout config (merge shorthand + structured)
  const resolvedTimeouts = resolveTimeouts(timeoutShorthand, timeoutsOption);

  /**
   * Wrapper for invokeOnError that binds the router's onError callback.
   * Uses the shared utility from router/error-handling.ts for consistent behavior.
   *
   * Deduplicates via per-request WeakSet stored on the ALS request context.
   * A closure-level WeakSet would silently swallow errors if the same object
   * instance is thrown across separate requests (e.g. a singleton error).
   */
  function callOnError(
    error: unknown,
    phase: ErrorPhase,
    context: Parameters<typeof invokeOnError<TEnv>>[3],
  ): void {
    if (error != null && typeof error === "object") {
      const reportedErrors = _getRequestContext()?._reportedErrors;
      if (reportedErrors) {
        if (reportedErrors.has(error)) return;
        reportedErrors.add(error);
      }
    }
    invokeOnError(onError, error, phase, context, "Router");
  }

  // Validate document is a client component. Under a test runner the "use
  // client" transform has not run, so a real exported document has no marker;
  // allowServerInTest lets the router construct in a bare unit test (for
  // dispatch / assertGeneratedRoutesMatch) while a real build still throws.
  if (documentOption !== undefined) {
    assertClientComponent(documentOption, "document", {
      allowServerInTest: true,
    });
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
      const parsed = compileMiddlewarePattern(fullPattern);
      regex = parsed.regex;
      paramNames = parsed.paramNames;
    }

    globalMiddleware.push({
      pattern: fullPattern,
      regex,
      paramNames,
      handler,
    });
  }

  // Track all registered routes with their prefixes for reverse().
  // Seed from injected NamedRoutes so reverse() works at module load time
  // for routes that come from lazy includes.
  const mergedRouteMap: Record<string, string> =
    flattenNamedRoutes(staticRouteNames);

  // Track names that came from the static seed so we can silently overwrite
  // them during routes() registration. The gen file may be stale during HMR,
  // so conflicts between seeded and runtime-registered values are expected.
  const seededNames = new Set(Object.keys(mergedRouteMap));

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
    const current = getRouterPrecomputedEntries(routerId);
    if (current !== precomputedSource) {
      precomputedSource = current;
      // buildPrecomputedByPrefix drops any staticPrefix owned by more than one
      // leaf include instead of collapsing it last-wins (which would mis-assign
      // one include's routes to another's entry and 500 a valid sibling route).
      // Such shared-prefix includes resolve via the handler path instead.
      precomputedByPrefix = current ? buildPrecomputedByPrefix(current) : null;
    }
    return precomputedByPrefix;
  }

  // Wrapper to pass debugPerformance to external createMetricsStore.
  // Also checks per-request flag set by ctx.debugPerformance() in middleware.
  // With no active request context there is nowhere to hang the store, so return
  // undefined: an orphan store would collect metrics no reader can reach (nothing
  // holds it, and appendMetric(undefined, ...) is already a no-op).
  const getMetricsStore = () => {
    const reqCtx = _getRequestContext();
    const enabled = debugPerformance || !!reqCtx?._debugPerformance;
    if (!enabled || !reqCtx) return undefined;
    // Anchor a mid-request store to the true request entry (reqCtx._handlerStart),
    // not this call's performance.now(); undefined falls back to now() inside
    // createMetricsStore (metrics.ts).
    reqCtx._metricsStore ??= createMetricsStore(true, reqCtx._handlerStart);
    return reqCtx._metricsStore;
  };

  // Wrapper to pass defaults to error/notFound boundary finders
  const findNearestErrorBoundary = (entry: EntryData | null) =>
    findErrorBoundary(entry, defaultErrorBoundary);

  const findNearestNotFoundBoundary = (entry: EntryData | null) =>
    findNotFoundBoundary(entry, defaultNotFoundBoundary);

  // Track a pending handler promise (non-blocking).
  // Attaches a side-effect .catch() to report streaming handler errors to onError
  // without altering the rejection chain (React's streaming error boundary still handles it).
  const trackHandler = <T>(
    promise: Promise<T>,
    errorContext?: {
      segmentId?: string;
      segmentType?: string;
    },
  ): Promise<T> => {
    // One ALS read serves both the store lookup and the onError closure.
    const reqCtx = _getRequestContext();
    const store = reqCtx?._handleStore;
    const tracked = store ? store.track(promise) : promise;

    // Report streaming handler errors to onError as a side-effect.
    // The rejection still propagates to the RSC stream for client error boundaries.
    // Captures request context eagerly (closure) so the catch handler has full context.
    if (reqCtx && onError) {
      tracked.catch((error) => {
        callOnError(error, "handler", {
          request: reqCtx.request,
          url: reqCtx.url,
          routeKey: reqCtx._routeName,
          params: reqCtx.params as Record<string, string>,
          env: reqCtx.env as TEnv,
          segmentId: errorContext?.segmentId,
          segmentType: errorContext?.segmentType as any,
          handledByBoundary: true,
        });
      });
    }

    return tracked;
  };

  // Wrapper for wrapLoaderWithErrorHandling that uses router's error boundary finder
  // Includes onError callback for loader error notification and telemetry emission.
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
    const loaderStart = telemetrySink ? performance.now() : 0;
    const loaderRequestId = telemetrySink
      ? errorContext?.request
        ? getRequestId(errorContext.request)
        : undefined
      : undefined;
    // Derived once here for both the loader.start and loader.end emits (the
    // loader.error emit uses ctx.loaderName from wrapLoaderWithErrorHandling).
    const loaderName = telemetrySink
      ? segmentId.split(".").pop() || "unknown"
      : "";
    if (telemetrySink) {
      safeEmit(telemetry, {
        type: "loader.start",
        timestamp: loaderStart,
        requestId: loaderRequestId,
        segmentId,
        loaderName,
        pathname,
      });
    }

    const result = wrapLoaderWithErrorHandling(
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
            if (telemetrySink) {
              const errorObj =
                error instanceof Error ? error : new Error(String(error));
              safeEmit(telemetry, {
                type: "loader.error",
                timestamp: performance.now(),
                requestId: loaderRequestId,
                segmentId: ctx.segmentId,
                loaderName: ctx.loaderName,
                pathname,
                error: errorObj,
                handledByBoundary: ctx.handledByBoundary,
              });
            }
          }
        : undefined,
    );

    // Emit loader.end after the promise settles (fire-and-forget)
    if (telemetrySink) {
      result.then((r) => {
        safeEmit(telemetry, {
          type: "loader.end",
          timestamp: performance.now(),
          requestId: loaderRequestId,
          segmentId,
          loaderName,
          pathname,
          durationMs: performance.now() - loaderStart,
          ok: r.ok,
        });
      });
    }

    return result;
  }

  // Dependencies object for extracted segment resolution functions.
  // Captures closure-bound helpers from createRouter.
  const segmentDeps: SegmentResolutionDeps<TEnv> = {
    wrapLoaderPromise,
    trackHandler,
    findNearestErrorBoundary,
    findNearestNotFoundBoundary,
    notFoundComponent: notFound,
    callOnError,
    viewTransitionDefault: viewTransitionOption,
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

  // Create segment resolution wrappers bound to segmentDeps
  const {
    resolveAllSegments,
    resolveLoadersOnly,
    resolveLoadersOnlyWithRevalidation,
    buildEntryRevalidateMap,
    resolveAllSegmentsWithRevalidation,
    findInterceptForRoute,
    resolveInterceptEntry,
    resolveInterceptLoadersOnly,
  } = createSegmentWrappers<TEnv>(segmentDeps);

  // Lazy evaluation deps — captures closure state for extracted evaluateLazyEntry
  const lazyEvalDeps: LazyEvalDeps<TEnv> = {
    routesEntries,
    mergedRouteMap,
    nextMountIndex: () => mountIndex++,
    getPrecomputedByPrefix,
    routerId,
  };

  // Must return the Promise from _evaluateLazyEntry: an async include provider
  // (`() => import("./routes")`) resolves off the startup path, and createFindMatch
  // awaits this to know when the import + expansion have completed. Dropping it
  // (typing this `void`) makes the import fire-and-forget, so findMatch spins the
  // lazy-eval retry loop to its cap and returns null on the first request to any
  // async include whose prefix isn't already covered by a unique precomputed entry
  // (nested includes, shared prefixes, regex fallback).
  function evaluateLazyEntry(entry: RouteEntry<TEnv>): void | Promise<void> {
    return _evaluateLazyEntry(entry, lazyEvalDeps);
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
      telemetry: telemetrySink,
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
    isPassthroughRoute?: boolean,
    buildEnv?: TEnv,
    devMode?: boolean,
  ) {
    return _matchForPrerender(
      pathname,
      params,
      prerenderDeps,
      buildVars,
      isPassthroughRoute,
      buildEnv,
      devMode,
    );
  }

  async function renderStaticSegment(
    handler: Function,
    handlerId: string,
    routeName?: string,
    buildEnv?: TEnv,
    devMode?: boolean,
  ) {
    return _renderStaticSegment<TEnv>(
      handler,
      handlerId,
      mergedRouteMap,
      routeName,
      buildEnv,
      devMode,
    );
  }

  // Create match handler functions bound to router state
  const matchHandlers = createMatchHandlers<TEnv>({
    buildRouterContext,
    callOnError,
    matchApiDeps,
    defaultErrorBoundary,
    findMatch,
    findInterceptForRoute,
    telemetry: telemetrySink,
    cacheSignalEnabled,
  });

  const { match, matchPartial, matchError, previewMatch } = matchHandlers;

  /**
   * Router instance
   * The type system tracks accumulated routes through the builder chain
   * Initial TRoutes is {} (empty) to avoid poisoning accumulated types with Record<string, string>
   */
  const router: RangoInternal<TEnv, {}> = {
    __brand: RSC_ROUTER_BRAND,
    id: routerId,
    basename,

    routes(patternsOrBuilder: UrlPatterns<TEnv> | UrlBuilder<TEnv>): any {
      // Wrap builder functions in urls() automatically
      const urlPatterns: UrlPatterns<TEnv> =
        typeof patternsOrBuilder === "function"
          ? (urls(patternsOrBuilder) as UrlPatterns<TEnv>)
          : patternsOrBuilder;

      // Store reference for runtime manifest generation
      storedUrlPatterns = urlPatterns;
      const currentMountIndex = mountIndex++;

      // Create manifest and patterns maps for route registration
      const manifest = new Map<string, EntryData>();
      const routePatterns = new Map<string, string>();
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
        parallel: {},
        intercept: [],
        loader: [],
      };

      let handlerResult: AllUseItems[] = [];
      RangoContext.run(
        {
          manifest,
          patterns: routePatterns,
          patternsByPrefix,
          trailingSlash: trailingSlashMap,
          namespace: "root",
          parent: syntheticMapRoot,
          counters: {},
          mountIndex: currentMountIndex,
          routerId,
          cacheProfiles: resolvedCacheProfiles,
          // basename sets the initial URL prefix so all path() patterns
          // are registered with the prefix (e.g. "/admin" + "/users" = "/admin/users").
          // No namePrefix — route names stay unprefixed.
          ...(basename ? { urlPrefix: basename } : {}),
        },
        () => {
          handlerResult = urlPatterns.handler() as AllUseItems[];
        },
      );

      // Convert trailingSlash map to object for the router
      const trailingSlashConfig =
        trailingSlashMap.size > 0
          ? Object.fromEntries(trailingSlashMap)
          : undefined;

      // Collect route keys that have prerender handlers (for non-trie match path)
      let prerenderRouteKeys: Set<string> | undefined;
      let passthroughRouteKeys: Set<string> | undefined;
      for (const [name, entry] of manifest.entries()) {
        if (entry.type === "route" && entry.isPrerender) {
          if (!prerenderRouteKeys) prerenderRouteKeys = new Set();
          prerenderRouteKeys.add(name);
          if (entry.isPassthrough === true) {
            if (!passthroughRouteKeys) passthroughRouteKeys = new Set();
            passthroughRouteKeys.add(name);
          }
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
            routerId,
            cacheProfiles: resolvedCacheProfiles,
            ...(prerenderRouteKeys ? { prerenderRouteKeys } : {}),
            ...(passthroughRouteKeys ? { passthroughRouteKeys } : {}),
          });
        }
      } else {
        // Fallback: no prefix grouping, use flat patterns map
        const routesObject: Record<string, string> = {};
        for (const [name, pattern] of routePatterns.entries()) {
          routesObject[name] = pattern;
        }

        routesEntries.push({
          prefix: "",
          staticPrefix: "",
          routes: routesObject as ResolvedRouteMap<any>,
          trailingSlash: trailingSlashConfig,
          handler: urlPatterns.handler,
          mountIndex: currentMountIndex,
          routerId,
          cacheProfiles: resolvedCacheProfiles,
          ...(prerenderRouteKeys ? { prerenderRouteKeys } : {}),
          ...(passthroughRouteKeys ? { passthroughRouteKeys } : {}),
        });
      }

      // Build route map from registered patterns
      for (const [name, pattern] of routePatterns.entries()) {
        // Runtime validation: warn if key already exists with different pattern.
        // Skip warning for entries that came from the static seed — the gen file
        // can be stale during HMR, so runtime registration is authoritative.
        const existingPattern = mergedRouteMap[name];
        if (
          existingPattern !== undefined &&
          existingPattern !== pattern &&
          !seededNames.has(name)
        ) {
          console.warn(
            `[@rangojs/router] Route name conflict: "${name}" already maps to "${existingPattern}", ` +
              `overwriting with "${pattern}". Use unique route names to avoid this.`,
          );
        }
        mergedRouteMap[name] = pattern;
        seededNames.delete(name);
      }

      // Detect lazy includes in handler result and create placeholder entries
      const lazyIncludes = findLazyIncludes(handlerResult);

      // Create placeholder RouteEntry for each lazy include
      for (const lazyInclude of lazyIncludes) {
        // Compute the full URL prefix (combining parent prefix if any). Use the
        // slash-collapsing join so a trailing-slash parent prefix does not
        // produce a double-slash staticPrefix the trie's sp can never match.
        const fullPrefix = joinPrefix(
          lazyInclude.context.urlPrefix,
          lazyInclude.prefix,
        );

        const lazyEntry: RouteEntry<TEnv> & { _lazyPrefix?: string } = {
          prefix: "",
          staticPrefix: extractStaticPrefix(fullPrefix),
          routes: {} as ResolvedRouteMap<any>, // Empty until first match
          trailingSlash: trailingSlashConfig,
          handler: urlPatterns.handler,
          mountIndex: mountIndex++,
          routerId,
          // Lazy evaluation fields
          lazy: true,
          lazyPatterns: lazyInclude.patterns,
          lazyContext: lazyInclude.context,
          lazyEvaluated: false,
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

      return router;
    },

    use(
      patternOrMiddleware: string | MiddlewareFn<TEnv>,
      middleware?: MiddlewareFn<TEnv>,
    ): any {
      // Auto-prefix pattern with basename so router-level middleware
      // patterns are router-relative (e.g. "/users/*" matches "/app/users/*").
      if (basename && typeof patternOrMiddleware === "string") {
        const pattern = patternOrMiddleware;
        const prefixed =
          pattern === "/*" || pattern === "*"
            ? `${basename}/*`
            : `${basename}${pattern}`;
        addMiddleware(prefixed, middleware, null);
      } else {
        addMiddleware(patternOrMiddleware, middleware, null);
      }
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

    // Expose resolved cache profiles for per-request resolution
    cacheProfiles: resolvedCacheProfiles,

    // Expose prefetch cache settings
    prefetchCacheControl,
    prefetchCacheTTL,
    prefetchCacheSize,
    prefetchConcurrency,

    // Expose the resolved rango state cookie name for the server-side writer
    // (invalidateClientCache) and for shipping to the client in metadata.
    resolvedStateCookieName,

    // Expose warmup enabled flag for handler and client
    warmupEnabled,

    // Expose StrictMode flag for the initial-render payload metadata
    strictMode,

    // Expose router-wide performance debugging for request-level metrics setup
    debugPerformance,

    // Expose the PPR shell-capture debug sink for the render layer
    // (rsc-rendering resolves it into the capture descriptor)
    debugShellCapture: debugShellCaptureOption,

    // Expose resolved span tracing for the handler (Cloudflare custom spans)
    tracing: resolvedTracing,

    // Expose the raw telemetry sink so handler-level emitters (timeout, origin
    // rejection, late-handle handler.error) can emit outside the match ALS.
    // Raw (not the resolveSink no-op wrapper) so router.telemetry stays
    // undefined when unconfigured and call sites gate on truthiness.
    telemetry: telemetrySink,

    // Expose origin check configuration for handler (default: enabled)
    originCheck: originCheckOption ?? true,

    // Expose SSR configuration for handler
    ssr: ssrOption,

    // Expose resolved timeouts for RSC handler
    timeouts: resolvedTimeouts,
    onTimeout,

    // Expose global middleware for RSC handler
    middleware: globalMiddleware,

    match: (request: Request, input: RouterRequestInput<TEnv> = {}) => {
      const env = input.env ?? ({} as TEnv);
      return match(request, env);
    },
    matchForPrerender,
    renderStaticSegment,
    matchPartial: (
      request: Request,
      input: RouterRequestInput<TEnv> = {},
      actionContext?: Parameters<typeof matchPartial>[2],
    ) => {
      const env = input.env ?? ({} as TEnv);
      return matchPartial(request, env, actionContext);
    },
    matchError: (
      request: Request,
      input: RouterRequestInput<TEnv> | undefined,
      error: unknown,
      segmentType?: Parameters<typeof matchError>[3],
    ) => {
      const env = input?.env ?? ({} as TEnv);
      return matchError(request, env, error, segmentType);
    },
    previewMatch: (request: Request, input: RouterRequestInput<TEnv> = {}) => {
      const env = input.env ?? ({} as TEnv);
      return previewMatch(request, env);
    },

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

    // Expose basename for runtime manifest generation
    __basename: basename,

    // Expose router-level boundary defaults for build-time clientChunks
    // discovery (so a "use client" default boundary lands in app-fallback).
    // These are createRouter options, never pushed onto EntryData.
    __defaultErrorBoundary: defaultErrorBoundary,
    __defaultNotFoundBoundary: defaultNotFoundBoundary,
    __notFound: notFound,

    // RSC request handler (lazily created on first call)
    fetch: (() => {
      // Handler is created on first call and reused
      let handler:
        | ((
            request: Request,
            input: RouterRequestInput<TEnv>,
          ) => Promise<Response>)
        | null = null;

      return async (request: Request, input: RouterRequestInput<TEnv> = {}) => {
        // Trigger lazy import of per-router manifest data before route matching.
        // No-op if data is already loaded or no loader is registered.
        await ensureRouterManifest(routerId);
        if (!handler) {
          // Lazy import deferred to first request to avoid dev mode issues
          const { createRSCHandler } = await import("./rsc/handler.js");
          // Cast: createRSCHandler receives `router as any`, which erases TEnv
          // and infers its handler as RouterRequestInput<unknown>. Re-narrow the
          // returned handler to RouterRequestInput<TEnv> so the call below stays
          // typed. (The handler already accepts (request, RouterRequestInput).)
          handler = createRSCHandler({
            router: router as any,
            cache,
            nonce,
            version,
          }) as (
            request: Request,
            input: RouterRequestInput<TEnv>,
          ) => Promise<Response>;
        }
        return handler!(request, input);
      };
    })(),

    // Low-level route matching for request classification
    findMatch: (pathname: string, metricsStore?: any) =>
      findMatch(pathname, metricsStore),

    // Debug utility for manifest inspection
    debugManifest: () => buildDebugManifest<TEnv>(routesEntries),
  };

  // Register router in the global registry for build-time discovery
  RouterRegistry.set(routerId, router);

  // If urls option was provided, auto-register them
  if (typeof urlsOption === "function") {
    return router.routes(urlsOption) as Rango<TEnv, {}>;
  } else if (urlsOption) {
    return router.routes(urlsOption) as Rango<TEnv, {}>;
  }

  return router;
}
