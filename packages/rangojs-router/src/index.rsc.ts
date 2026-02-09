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
  RouterError,
} from "./index.js";

// Re-export all types from types.ts (user-facing types only)
export type {
  // Configuration types
  DocumentProps,
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

// Router options type (server-only, so import directly)
export type { RSCRouterOptions } from "./router.js";

// Server-side createLoader and redirect
export { createLoader, redirect } from "./route-definition.js";

// Handle API
export { createHandle, isHandle, type Handle } from "./handle.js";

// Pre-render handler API
export {
  createPrerenderHandler,
  isPrerenderHandler,
  type PrerenderHandlerDefinition,
  type PrerenderOptions,
  type BuildContext,
} from "./prerender.js";

// Django-style URL patterns (RSC/server context)
export {
  urls,
  type PathHelpers,
  type PathOptions,
  type UrlPatterns,
  type IncludeOptions,
  type IncludeItem,
  type RouteResponse,
  type ResponseError,
  type ResponseEnvelope,
} from "./urls.js";

// Core router (server-side)
export {
  createRouter,
  type RSCRouter,
  type RootLayoutProps,
} from "./router.js";

// RSC handler types (server-side)
export type { HandlerCacheConfig } from "./rsc/types.js";

// Built-in handles (server-side)
export { Meta } from "./handles/meta.js";

// Request context (for accessing request data in server actions/components)
export { getRequestContext, type RequestContext } from "./server/request-context.js";

// Meta types
export type { MetaDescriptor, MetaDescriptorBase } from "./router/types.js";

// Href type utilities for type-safe URL generation
export type { ScopedHrefFunction, HrefFunction, ExtractLocalRoutes } from "./href.js";
export { scopedHref } from "./href.js";
