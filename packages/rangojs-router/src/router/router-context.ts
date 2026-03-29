/**
 * Router Context
 *
 * Provides clean dependency injection for router middleware without parameter drilling.
 * All closure functions from createRouter() are made available via getRouterContext().
 *
 * Stored as _router on the canonical request context (derived ALS snapshot).
 */
import {
  _getRequestContext,
  _requestContextStorage,
} from "../server/request-context.js";
import type { CacheScope } from "../cache/cache-scope.js";
import type {
  EntryData,
  InterceptEntry,
  InterceptSelectorContext,
  MetricsStore,
} from "../server/context.js";
import type {
  HandlerContext,
  ResolvedSegment,
  ShouldRevalidateFn,
} from "../types.js";
import type { RouteMatchResult } from "./pattern-matching.js";
import type { TelemetrySink } from "./telemetry.js";

/**
 * Revalidation context passed to segment resolution
 */
export interface RevalidationContext {
  clientSegmentIds: Set<string>;
  prevParams: Record<string, string>;
  request: Request;
  prevUrl: URL;
  nextUrl: URL;
  routeKey: string;
  actionContext?: {
    actionId?: string;
    actionUrl?: URL;
    actionResult?: any;
    formData?: FormData;
  };
  stale: boolean;
}

/**
 * Result from intercept lookup
 */
export interface InterceptResult {
  intercept: InterceptEntry;
  entry: EntryData;
}

/**
 * Router context available via AsyncLocalStorage
 *
 * Contains closure functions from createRouter() that middleware needs access to.
 * Instead of passing 20+ parameters, middleware calls getRouterContext() to access them.
 */
export interface RouterContext<TEnv = any> {
  // Route matching
  findMatch: (pathname: string) => RouteMatchResult | null;

  // Manifest loading
  loadManifest: (
    entry: any,
    routeKey: string,
    pathname: string,
    metricsStore?: MetricsStore,
    isSSR?: boolean,
  ) => Promise<EntryData>;

  // Entry traversal
  traverseBack: (entry: EntryData) => Generator<EntryData>;

  // Handler context creation
  createHandlerContext: (
    params: Record<string, string>,
    request: Request,
    searchParams: URLSearchParams,
    pathname: string,
    url: URL,
    bindings?: any,
    routeMap?: Record<string, string>,
    routeName?: string,
    responseType?: string,
    isPassthroughRoute?: boolean,
  ) => HandlerContext<any, TEnv>;

  // Loader setup
  setupLoaderAccess: (
    ctx: HandlerContext<any, TEnv>,
    loaderPromises: Map<string, Promise<any>>,
  ) => void;

  setupLoaderAccessSilent: (
    ctx: HandlerContext<any, TEnv>,
    loaderPromises: Map<string, Promise<any>>,
  ) => void;

  // Context access
  getContext: () => {
    getOrCreateStore: (key: string) => any;
    runWithStore: <T>(
      store: any,
      namespace: string,
      parent: any,
      fn: () => T,
    ) => T;
  };

  // Metrics
  getMetricsStore: () => MetricsStore | undefined;

  // Cache
  createCacheScope: (
    cacheConfig: any,
    parent: CacheScope | null,
  ) => CacheScope | null;

  // Intercept detection
  findInterceptForRoute: (
    routeKey: string,
    parentEntry: EntryData | null,
    selectorContext: InterceptSelectorContext,
    isAction: boolean,
  ) => InterceptResult | null;

  // Segment resolution (with revalidation)
  resolveAllSegmentsWithRevalidation: (
    entries: EntryData[],
    routeKey: string,
    params: Record<string, string>,
    handlerContext: HandlerContext<any, TEnv>,
    clientSegmentSet: Set<string>,
    prevParams: Record<string, string>,
    request: Request,
    prevUrl: URL,
    nextUrl: URL,
    loaderPromises: Map<string, Promise<any>>,
    actionContext: any | undefined,
    interceptResult: InterceptResult | null,
    localRouteName: string,
    pathname: string,
    stale?: boolean,
  ) => Promise<{ segments: ResolvedSegment[]; matchedIds: string[] }>;

  // Generator-based segment resolution (for pipeline)
  resolveAllSegmentsWithRevalidationGenerator?: (
    entries: EntryData[],
    routeKey: string,
    params: Record<string, string>,
    handlerContext: HandlerContext<any, TEnv>,
    clientSegmentSet: Set<string>,
    prevParams: Record<string, string>,
    request: Request,
    prevUrl: URL,
    nextUrl: URL,
    loaderPromises: Map<string, Promise<any>>,
    actionContext?: any,
  ) => AsyncGenerator<ResolvedSegment | { __type: "id"; id: string }>;

  // Intercept resolution
  resolveInterceptEntry: (
    intercept: InterceptEntry,
    entry: EntryData,
    params: Record<string, string>,
    handlerContext: HandlerContext<any, TEnv>,
    belongsToRoute: boolean,
    revalidationContext?: RevalidationContext,
  ) => Promise<ResolvedSegment[]>;

  // Collect with markers
  collectWithMarkers?: <T>(
    gen: AsyncGenerator<T | { __type: "id"; id: string }>,
  ) => Promise<{ items: T[]; matchedIds: string[] }>;

  // Revalidation evaluation
  evaluateRevalidation: (params: {
    segment: ResolvedSegment;
    prevParams: Record<string, string>;
    getPrevSegment: (() => Promise<ResolvedSegment | undefined>) | null;
    request: Request;
    prevUrl: URL;
    nextUrl: URL;
    revalidations: Array<{ name: string; fn: any }>;
    routeKey: string;
    context: HandlerContext<any, TEnv>;
    actionContext?: any;
    stale?: boolean;
    traceSource?:
      | "segment-resolution"
      | "cache-hit"
      | "loader"
      | "parallel"
      | "orphan-layout"
      | "route-handler"
      | "layout-handler"
      | "intercept-loader";
  }) => Promise<boolean>;

  // Request context
  getRequestContext: () =>
    | {
        waitUntil: (fn: () => Promise<void>) => void;
        _handleStore?: any;
      }
    | undefined;

  // Simple segment resolution (without revalidation - for full match)
  resolveAllSegments: (
    entries: EntryData[],
    routeKey: string,
    params: Record<string, string>,
    handlerContext: HandlerContext<any, TEnv>,
    loaderPromises: Map<string, Promise<any>>,
    options?: { skipLoaders?: boolean },
  ) => Promise<ResolvedSegment[]>;

  // Generator-based simple resolution
  resolveAllSegmentsGenerator?: (
    entries: EntryData[],
    routeKey: string,
    params: Record<string, string>,
    handlerContext: HandlerContext<any, TEnv>,
    loaderPromises: Map<string, Promise<any>>,
  ) => AsyncGenerator<ResolvedSegment | { __type: "id"; id: string }>;

  // Collect segments from generator
  collectSegmentsFromGenerator?: <T>(
    gen: AsyncGenerator<T | { __type: "id"; id: string }>,
  ) => Promise<T[]>;

  // Handle store
  createHandleStore: () => any;

  // Loaders-only resolution (for full match cache hit - no revalidation)
  resolveLoadersOnly?: (
    entries: EntryData[],
    handlerContext: HandlerContext<any, TEnv>,
  ) => Promise<ResolvedSegment[]>;

  // Loaders-only resolution (for cache hit scenarios)
  resolveLoadersOnlyWithRevalidation?: (
    entries: EntryData[],
    handlerContext: HandlerContext<any, TEnv>,
    clientSegmentSet: Set<string>,
    prevParams: Record<string, string>,
    request: Request,
    prevUrl: URL,
    nextUrl: URL,
    routeKey: string,
    actionContext?: any,
    stale?: boolean,
  ) => Promise<{ segments: ResolvedSegment[]; matchedIds: string[] }>;

  // Entry revalidation map
  buildEntryRevalidateMap?: (
    entries: EntryData[],
  ) => Map<string, { revalidate: ShouldRevalidateFn[] }>;

  // Telemetry sink (optional, no-op when undefined)
  telemetry?: TelemetrySink;

  // Request ID for telemetry span correlation (set per-request in match handlers)
  requestId?: string;

  // Intercept loaders only (for cache hit + intercept scenarios)
  resolveInterceptLoadersOnly?: (
    intercept: InterceptEntry,
    entry: EntryData,
    params: Record<string, string>,
    handlerContext: HandlerContext<any, TEnv>,
    belongsToRoute: boolean,
    revalidationContext: {
      clientSegmentIds: Set<string>;
      prevParams: Record<string, string>;
      request: Request;
      prevUrl: URL;
      nextUrl: URL;
      routeKey: string;
      actionContext?: any;
      stale?: boolean;
    },
  ) => Promise<{
    loaderDataPromise: Promise<any[]> | any[];
    loaderIds: string[];
  } | null>;
}

/**
 * Get router dependencies from the canonical request context.
 *
 * @throws Error if called outside of router context (runWithRouterContext)
 */
export function getRouterContext<TEnv = any>(): RouterContext<TEnv> {
  const ctx = _getRequestContext();
  const router = ctx?._router;
  if (!router) {
    throw new Error(
      "getRouterContext() called outside of router context. " +
        "Ensure code is running inside runWithRouterContext().",
    );
  }
  return router as RouterContext<TEnv>;
}

/**
 * Run a function with router dependencies available via getRouterContext().
 *
 * Creates a derived ALS snapshot on the canonical request context with _router set.
 * Requires an active request context — throws if called outside runWithRequestContext().
 */
export function runWithRouterContext<T, TEnv = any>(
  deps: RouterContext<TEnv>,
  fn: () => T,
): T {
  const ctx = _getRequestContext();
  if (!ctx) {
    throw new Error(
      "runWithRouterContext() called outside of request context. " +
        "Ensure code is running inside runWithRequestContext().",
    );
  }
  return _requestContextStorage.run({ ...ctx, _router: deps }, fn);
}
