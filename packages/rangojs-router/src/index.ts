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

// Href type utilities for type-safe URL generation
// ScopedHrefFunction is used with useHref<typeof patterns>() for composable modules
export type { ScopedHrefFunction, HrefFunction, ExtractLocalRoutes } from "./href.js";
// scopedHref() helper for handlers to get locally-typed href
export { scopedHref } from "./href.js";
