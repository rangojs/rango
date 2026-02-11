/**
 * rsc-router
 *
 * Universal exports - types and utilities safe for both server and client
 *
 * For server-only exports (urls, createRouter, createLoader, etc.):
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
  RouterError,
} from "./errors.js";

// Types (safe to import anywhere - no runtime code)
export type {
  // Configuration types
  DocumentProps,
  RouterEnv,
  DefaultEnv,
  RouteDefinition,
  // Handler types
  Handler,            // Supports params object, path pattern, or route name
  ScopedRouteMap,     // Scoped view of GeneratedRouteMap for Handler<"localName", ScopedRouteMap<"prefix">>
  HandlerContext,
  ExtractParams,
  GenericParams,
  // Middleware types
  Middleware,
  // Revalidation types
  RevalidateParams,
  Revalidate,
  RouteKeys,
  // Loader types
  LoaderDefinition,
  LoaderFn,
  LoaderContext,
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

// Client-safe createLoader - only stores the $$id, function is not included
// Use this when defining loaders that will be imported by client components
export { createLoader } from "./loader.js";

// Response route types (usable in both server and client contexts)
export type {
  ResponseHandler,
  ResponseHandlerContext,
  JsonResponseHandler,
  TextResponseHandler,
  JsonValue,
  ResponsePathFn,
  JsonResponsePathFn,
  TextResponsePathFn,
  RouteResponse,
  ResponseError,
  ResponseEnvelope,
} from "./urls.js";

/**
 * Error-throwing stub for server-only `urls` function.
 * Import from "@rangojs/router/server" or use within RSC context instead.
 */
export function urls(): never {
  throw new Error(
    'urls() is server-only. Import from "@rangojs/router/server" instead, or ensure you\'re using it in a server component.'
  );
}

/**
 * Error-throwing stub for server-only `createRouter` function.
 * Import from "@rangojs/router/server" instead.
 */
export function createRouter(): never {
  throw new Error(
    'createRouter() is server-only. Import from "@rangojs/router/server" instead.'
  );
}

/**
 * Error-throwing stub for server-only `redirect` function.
 * Import from "@rangojs/router/server" or use within RSC context instead.
 */
export function redirect(): never {
  throw new Error(
    'redirect() is server-only. Import from "@rangojs/router/server" instead.'
  );
}

/**
 * Error-throwing stub for server-only `createHandle` function.
 * Import from "@rangojs/router/server" or use within RSC context instead.
 */
export function createHandle(): never {
  throw new Error(
    'createHandle() is server-only. Import from "@rangojs/router/server" instead.'
  );
}

/**
 * Error-throwing stub for server-only `createPrerenderHandler` function.
 * Import from "@rangojs/router/server" or use within RSC context instead.
 */
export function createPrerenderHandler(): never {
  throw new Error(
    'createPrerenderHandler() is server-only. Import from "@rangojs/router/server" instead.'
  );
}

// Handle API (type-only exports safe for client)
export { isHandle, type Handle } from "./handle.js";

/**
 * Error-throwing stub for server-only `getRequestContext` function.
 * Import from "@rangojs/router/server" or use within RSC context instead.
 */
export function getRequestContext(): never {
  throw new Error(
    'getRequestContext() is server-only. Import from "@rangojs/router/server" instead.'
  );
}

// Request context type (safe for client)
export type { RequestContext } from "./server/request-context.js";

// Meta types
export type { MetaDescriptor, MetaDescriptorBase } from "./router/types.js";

// Reverse type utilities for type-safe URL generation (Django-style URL reversal)
// ScopedReverseFunction is used with scopedReverse<typeof patterns>() for composable modules
export type { ScopedReverseFunction, ReverseFunction, ExtractLocalRoutes } from "./reverse.js";
// scopedReverse() helper for handlers to get locally-typed reverse
export { scopedReverse } from "./reverse.js";

// Path-based response type lookup from RegisteredRoutes
export type { PathResponse } from "./href-client.js";
