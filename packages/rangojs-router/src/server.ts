/**
 * rsc-router/server
 *
 * Server-only exports for route definition and building
 * These should only be imported in server-side handler files
 */

// Route definition helpers (server-only)
export {
  createLoader,
  redirect,
  type RouteHelpers,
  type RouteHandlers,
} from "./route-definition.js";

// Django-style URL patterns (server-only)
export {
  urls,
  type PathHelpers,
  type PathOptions,
  type UrlPatterns,
  type IncludeOptions,
} from "./urls.js";

// Re-export IncludeItem from route-types
export type { IncludeItem } from "./route-types.js";

// Core router (server-only)
export {
  createRouter,
  type RSCRouter,
  type RSCRouterOptions,
  type RootLayoutProps,
} from "./router.js";

// Type-safe href utilities
export {
  createHref,
  type HrefFunction,
  type PrefixedRoutes,
  type PrefixRoutePatterns,
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
export { registerLoaderById, setLoaderImports } from "./server/loader-registry.js";

// Request context (for accessing request data in server components/actions)
export {
  getRequestContext,
  requireRequestContext,
  createRequestContext,
  type RequestContext,
  type CreateRequestContextOptions,
} from "./server/request-context.js";

// Meta types
export type { MetaDescriptor, MetaDescriptorBase } from "./router/types.js";

// Middleware context types (Middleware type is exported from types.ts)
export type {
  MiddlewareContext,
  CookieOptions,
} from "./router/middleware.js";

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

// Component utilities
export {
  isClientComponent,
  assertClientComponent,
} from "./component-utils.js";

// Types (re-exported for convenience - user-facing only)
export type {
  // Configuration types
  RouterEnv,
  DefaultEnv,
  RouteDefinition,
  RouteConfig,
  RouteDefinitionOptions,
  TrailingSlashMode,
  // Handler types
  Handler,            // Supports params object, path pattern, or route name
  HandlerContext,
  ExtractParams,
  GenericParams,
  // Middleware types (also exported from router/middleware.js above)
  Middleware,         // Supports env type and optional route name for params
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
  // Error handling callback types
  ErrorPhase,
  OnErrorContext,
  OnErrorCallback,
} from "./types.js";
