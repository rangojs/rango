/**
 * rsc-router
 *
 * Universal exports - types and utilities safe for both server and client
 *
 * For server-only exports (urls, createRSCRouter, createLoader, etc.):
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

// Router options type
export type { RSCRouterOptions } from "./router.js";

// Client-safe createLoader - only stores the $$id, function is not included
// Use this when defining loaders that will be imported by client components
export { createLoader } from "./loader.js";


// Django-style URL patterns API
export { urls, type UrlPatterns, type PathHelpers } from "./urls.js";

// Core router types
export type { RSCRouter, RootLayoutProps } from "./router.js";

// RSC handler types
export type { CreateRSCHandlerOptions, HandlerCacheConfig } from "./rsc/types.js";

// Meta handle type
export type { MetaDescriptor, MetaDescriptorBase } from "./router/types.js";
