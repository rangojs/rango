/**
 * rsc-router/server
 *
 * Server-only exports for route definition and building
 * These should only be imported in server-side handler files
 */

// Route definition helpers (server-only)
export {
  route,
  map,
  createLoader,
  redirect,
  type RouteHelpers,
  type InterceptSelectorContext,
  type InterceptSegmentsState,
  type InterceptWhenFn,
} from "./route-definition.js";

// Core router (server-only)
export {
  createRSCRouter,
  type RSCRouter,
  type RSCRouterOptions,
  type RootLayoutProps,
} from "./router.js";

// Type-safe href utilities
export {
  createHref,
  type HrefFunction,
  type PrefixedRoutes,
  type ParamsFor,
  type SanitizePrefix,
  type MergeRoutes,
} from "./href.js";

// Segment system (server-only)
export { renderSegments } from "./segment-system.js";

// Performance tracking (server-only)
export { track } from "./server/context.js";

// Handle API (works in both server and client contexts)
export { createHandle, isHandle, type Handle } from "./handle.js";

// Built-in handles
export { Meta } from "./handles/meta.js";

// Loader registry (for GET-based loader fetching)
export { registerLoaderById } from "./server/loader-registry.js";

// Meta types
export type { MetaDescriptor, MetaDescriptorBase } from "./router/types.js";

// Error classes and utilities
export {
  RouteNotFoundError,
  DataNotFoundError,
  notFound,
  MiddlewareError,
  HandlerError,
  BuildError,
  InvalidHandlerError,
  sanitizeError,
} from "./errors.js";

// Types (re-exported for convenience)
export type {
  RouterEnv,
  DefaultEnv,
  RouteDefinition,
  RouteConfig,
  RouteDefinitionOptions,
  TrailingSlashMode,
  ResolvedRouteMap,
  Handler,
  HandlerContext,
  HandlersForRouteMap,
  ResolvedSegment,
  SegmentMetadata,
  MatchResult,
  SlotState,
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
  GetRegisteredRoutes,
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
