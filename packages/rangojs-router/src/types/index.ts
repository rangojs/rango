// Global namespace (must be imported for side effects: `declare global`)
export type {
  GetRegisteredRoutes,
  DefaultHandlerRouteMap,
  DefaultEnv,
} from "./global-namespace.js";
// Ensure the global namespace declaration is evaluated
import "./global-namespace.js";

// Route configuration
export type {
  DocumentProps,
  RouterEnv,
  ExtractParams,
  TrailingSlashMode,
  RouteConfig,
  RouteDefinitionOptions,
  RouteDefinition,
  ResolvedRouteMap,
} from "./route-config.js";

// Boundaries (error/notFound)
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

// Handler context and related types
export type {
  MiddlewareFn,
  ScopedRouteMap,
  Handler,
  HandlerContext,
  InternalHandlerContext,
  GenericParams,
  RevalidateParams,
  ShouldRevalidateFn,
  RouteKeys,
  ExtractRouteParams,
  HandlersForRouteMap,
  Revalidate,
  Middleware,
} from "./handler-context.js";

// Segments
export type {
  ViewTransitionClass,
  TransitionConfig,
  ResolvedSegment,
  SegmentMetadata,
  SlotState,
  RootLayoutProps,
  MatchResult,
} from "./segments.js";

// Route entries
export type { LazyIncludeContext, RouteEntry } from "./route-entry.js";

// Loader types
export type {
  LoaderContext,
  LoaderFn,
  FetchableLoaderOptions,
  LoadOptions,
  LoaderDefinition,
} from "./loader-types.js";

// Cache types
export type {
  CacheContext,
  CacheOptions,
  PartialCacheOptions,
  EntryCacheConfig,
} from "./cache-types.js";

// Error handling types
export type {
  ErrorPhase,
  OnErrorContext,
  OnErrorCallback,
} from "./error-types.js";
