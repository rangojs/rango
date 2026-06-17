/**
 * Router Context using AsyncLocalStorage
 *
 * Provides clean dependency injection for router middleware without parameter drilling.
 * All closure functions from createRouter() are made available via getRouterContext().
 */
import { AsyncLocalStorage } from "async_hooks";
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
import type { ResolveSegmentOptions } from "./segment-resolution.js";

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
  findMatch: (pathname: string) => RouteMatchResult | null;

  loadManifest: (
    entry: any,
    routeKey: string,
    pathname: string,
    metricsStore?: MetricsStore,
    isSSR?: boolean,
  ) => Promise<EntryData>;

  traverseBack: (entry: EntryData) => Generator<EntryData>;

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

  setupLoaderAccess: (
    ctx: HandlerContext<any, TEnv>,
    loaderPromises: Map<string, Promise<any>>,
  ) => void;

  setupLoaderAccessSilent: (
    ctx: HandlerContext<any, TEnv>,
    loaderPromises: Map<string, Promise<any>>,
  ) => void;

  getContext: () => {
    getOrCreateStore: (key: string) => any;
    runWithStore: <T>(
      store: any,
      namespace: string,
      parent: any,
      fn: () => T,
    ) => T;
  };

  getMetricsStore: () => MetricsStore | undefined;

  createCacheScope: (
    cacheConfig: any,
    parent: CacheScope | null,
  ) => CacheScope | null;

  findInterceptForRoute: (
    routeKey: string,
    parentEntry: EntryData | null,
    selectorContext: InterceptSelectorContext,
    isAction: boolean,
  ) => InterceptResult | null;

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

  collectWithMarkers?: <T>(
    gen: AsyncGenerator<T | { __type: "id"; id: string }>,
  ) => Promise<{ items: T[]; matchedIds: string[] }>;

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

  getRequestContext: () =>
    | {
        waitUntil: (fn: () => Promise<void>) => void;
        _handleStore?: any;
      }
    | undefined;

  resolveAllSegments: (
    entries: EntryData[],
    routeKey: string,
    params: Record<string, string>,
    handlerContext: HandlerContext<any, TEnv>,
    loaderPromises: Map<string, Promise<any>>,
    options?: ResolveSegmentOptions,
  ) => Promise<ResolvedSegment[]>;

  resolveAllSegmentsGenerator?: (
    entries: EntryData[],
    routeKey: string,
    params: Record<string, string>,
    handlerContext: HandlerContext<any, TEnv>,
    loaderPromises: Map<string, Promise<any>>,
  ) => AsyncGenerator<ResolvedSegment | { __type: "id"; id: string }>;

  collectSegmentsFromGenerator?: <T>(
    gen: AsyncGenerator<T | { __type: "id"; id: string }>,
  ) => Promise<T[]>;

  createHandleStore: () => any;

  resolveLoadersOnly?: (
    entries: EntryData[],
    handlerContext: HandlerContext<any, TEnv>,
  ) => Promise<ResolvedSegment[]>;

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

  requestId?: string;

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

const routerContext = new AsyncLocalStorage<RouterContext<any>>();

/**
 * Get router dependencies from AsyncLocalStorage context
 *
 * @throws Error if called outside of router context (runWithRouterContext)
 */
export function getRouterContext<TEnv = any>(): RouterContext<TEnv> {
  const deps = routerContext.getStore();
  if (!deps) {
    throw new Error(
      "getRouterContext() called outside of router context. " +
        "Ensure code is running inside runWithRouterContext().",
    );
  }
  return deps as RouterContext<TEnv>;
}

/**
 * Run a function with router dependencies available via getRouterContext()
 *
 * All async code within fn() can call getRouterContext() to access router closures.
 * This works across async boundaries thanks to AsyncLocalStorage.
 */
export function runWithRouterContext<T, TEnv = any>(
  deps: RouterContext<TEnv>,
  fn: () => T,
): T {
  return routerContext.run(deps, fn);
}
