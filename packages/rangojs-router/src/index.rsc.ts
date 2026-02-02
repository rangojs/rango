/**
 * rsc-router (react-server environment)
 *
 * This file is used when importing "rsc-router" from RSC (server components).
 * It re-exports everything from the universal index.ts plus adds server-side
 * createLoader that includes the actual loader function.
 *
 * The bundler uses the "react-server" export condition to select this file
 * in RSC context, while the regular index.ts is used in client components.
 */

// Re-export all universal exports from index.ts
export {
  // Universal rendering utilities
  renderSegments,
  // Error classes
  RouteNotFoundError,
  DataNotFoundError,
  notFound,
  MiddlewareError,
  HandlerError,
  BuildError,
  InvalidHandlerError,
  NetworkError,
  isNetworkError,
  sanitizeError,
  // Route pattern definition
  route,
} from "./index.js";

// Re-export all types from index.ts
export type {
  RouterEnv,
  DefaultEnv,
  RouteDefinition,
  ResolvedRouteMap,
  Handler,
  HandlerContext,
  HandlersForRouteMap,
  ResolvedSegment,
  SegmentMetadata,
  MatchResult,
  ExtractParams,
  GenericParams,
  RevalidateParams,
  ShouldRevalidateFn,
  MiddlewareFn,
  RouteKeys,
  RouteHandler,
  RouteRevalidateFn,
  RouteMiddlewareFn,
  LoaderDefinition,
  LoaderFn,
  LoaderContext,
  ErrorInfo,
  ErrorBoundaryFallbackProps,
  ErrorBoundaryHandler,
  ClientErrorBoundaryFallbackProps,
  NotFoundInfo,
  NotFoundBoundaryFallbackProps,
  NotFoundBoundaryHandler,
  RSCRouterOptions,
  PerformanceMetric,
  MetricsStore,
} from "./index.js";

// Server-side createLoader - includes the actual loader function
// This is the key addition for RSC context
export { createLoader } from "./route-definition.js";

// Django-style URL patterns (RSC/server context)
export {
  urls,
  type PathHelpers,
  type PathOptions,
  type UrlPatterns,
  type IncludeOptions,
  type IncludeItem,
} from "./urls.js";
