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
  MiddlewareError,
  HandlerError,
  BuildError,
  InvalidHandlerError,
  sanitizeError,
} from "./errors.js";

// Types (safe to import anywhere - no runtime code)
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
