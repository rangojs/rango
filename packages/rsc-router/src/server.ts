/**
 * rsc-router/server
 *
 * Server-only exports for route definition and building
 * These should only be imported in server-side handler files
 */

// Route definition helpers (server-only)
export { route, map, createLoader, redirect, type RouteHelpers, type MapOptions } from "./route-definition.js";

// Core router (server-only)
export { createRSCRouter, type RSCRouter } from "./router.js";

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
