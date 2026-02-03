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

// Re-export all types from index.ts (user-facing types only)
export type {
  // Configuration types
  RouterEnv,
  DefaultEnv,
  RouteDefinition,
  // Handler types
  Handler,
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
  // Error boundary types
  ErrorInfo,
  ErrorBoundaryFallbackProps,
  ErrorBoundaryHandler,
  ClientErrorBoundaryFallbackProps,
  // NotFound boundary types
  NotFoundInfo,
  NotFoundBoundaryFallbackProps,
  NotFoundBoundaryHandler,
  // Router options
  RSCRouterOptions,
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

// Core router (server-side)
export {
  createRSCRouter,
  type RSCRouter,
  type RootLayoutProps,
} from "./router.js";

// RSC handler (server-side)
export { createRSCHandler } from "./rsc/handler.js";
export type { CreateRSCHandlerOptions, HandlerCacheConfig } from "./rsc/types.js";

// Built-in handles (server-side)
export { Meta } from "./handles/meta.js";
