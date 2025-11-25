/**
 * rsc-router/server
 *
 * Server-only exports for route definition and building
 * These should only be imported in server-side handler files
 */

// Route definition helpers (server-only)
export { route, map, createLoader, type RouteHelpers } from "./route-definition.js";

// Core router (server-only)
export { createRSCRouter, type RSCRouter } from "./router.js";

// Segment system (server-only)
export { renderSegments } from "./segment-system.js";

// Error classes and utilities
export {
  RouteNotFoundError,
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
} from "./types.js";
