/**
 * rsc-router
 *
 * Universal exports - types and utilities safe for both server and client
 *
 * For server-only exports (route, map, createRSCRouter, etc.):
 *   import from "rsc-router/server"
 *
 * For client-only exports (Outlet, useOutlet, etc.):
 *   import from "rsc-router/client"
 */

// Universal rendering utilities (work on both server and client)
export { renderSegments } from "./segment-system.js";

// Error classes (can be used on both server and client)
export {
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
} from "./errors.js";

// Types (safe to import anywhere - no runtime code)
export type {
  DocumentProps,
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
  // Fetchable loader types
  FetchableLoaderOptions,
  LoadOptions,
  LoaderActionContext,
  LoaderAction,
  LoaderMiddlewareFn,
  // Error boundary types
  ErrorInfo,
  ErrorBoundaryFallbackProps,
  ErrorBoundaryHandler,
  ClientErrorBoundaryFallbackProps,
  // NotFound boundary types
  NotFoundInfo,
  NotFoundBoundaryFallbackProps,
  NotFoundBoundaryHandler,
} from "./types.js";

// Router options type
export type { RSCRouterOptions } from "./router.js";

// Metrics types
export type { PerformanceMetric, MetricsStore } from "./server/context.js";

// Client-safe createLoader - only stores the $$id, function is not included
// Use this when defining loaders that will be imported by client components
export { createLoader } from "./loader.js";

// Route pattern definition helper
// Used to define route patterns in a shared routes.ts file
export { route } from "./route-utils.js";

// Django-style URL patterns API
export { urls, type UrlPatterns, type PathHelpers } from "./urls.js";
