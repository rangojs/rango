export type {
  GetRegisteredRoutes,
  DefaultHandlerRouteMap,
  DefaultReverseRouteMap,
  DefaultEnv,
} from "./global-namespace.js";
import "./global-namespace.js";

export type {
  DocumentProps,
  ExtractParams,
  TrailingSlashMode,
  RouteConfig,
  RouteDefinitionOptions,
  RouteDefinition,
  ResolvedRouteMap,
} from "./route-config.js";

export type {
  ErrorInfo,
  ErrorBoundaryFallbackProps,
  ErrorBoundaryHandler,
  ClientErrorBoundaryFallbackProps,
  LoaderDataResult,
  NotFoundInfo,
  NotFoundBoundaryFallbackProps,
  NotFoundBoundaryHandler,
} from "./boundaries.js";
export { isLoaderDataResult } from "./boundaries.js";

export type {
  MiddlewareFn,
  ScopedRouteMap,
  Handler,
  HandlerContext,
  InternalHandlerContext,
  GenericParams,
  RevalidateParams,
  ShouldRevalidateFn,
  ActionRef,
  RouteKeys,
  ExtractRouteParams,
  HandlersForRouteMap,
  Revalidate,
  Middleware,
} from "./handler-context.js";

export type {
  ViewTransitionClass,
  TransitionConfig,
  ResolvedSegment,
  SegmentMetadata,
  SlotState,
  RootLayoutProps,
  MatchResult,
} from "./segments.js";

export type { LazyIncludeContext, RouteEntry } from "./route-entry.js";

export type {
  LoaderContext,
  LoaderFn,
  FetchableLoaderOptions,
  LoadOptions,
  LoaderDefinition,
} from "./loader-types.js";

export type {
  CacheContext,
  CacheOptions,
  PartialCacheOptions,
  EntryCacheConfig,
} from "./cache-types.js";

export type {
  ErrorPhase,
  OnErrorContext,
  OnErrorCallback,
} from "./error-types.js";
