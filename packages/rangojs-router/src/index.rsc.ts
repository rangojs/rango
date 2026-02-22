/**
 * @rangojs/router (react-server environment)
 *
 * This file is used when importing "@rangojs/router" from RSC (server components).
 * It re-exports everything from the universal index.ts plus adds server-side
 * implementations that replace the client-side error stubs.
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
  RouteConfig,
  RouteDefinitionOptions,
  TrailingSlashMode,
  // Handler types
  Handler,
  ScopedRouteMap,
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
  // Error handling callback types
  ErrorPhase,
  OnErrorContext,
  OnErrorCallback,
} from "./types.js";

// Router options type (server-only, so import directly)
export type { RSCRouterOptions } from "./router.js";

// Server-side createLoader and redirect
export {
  createLoader,
  redirect,
  type RouteHelpers,
  type RouteHandlers,
  // Globally importable route helpers for composition
  layout,
  cache,
  middleware,
  revalidate,
  loader,
  loading,
  parallel,
  intercept,
  when,
  errorBoundary,
  notFoundBoundary,
} from "./route-definition.js";

// Composition types for reusable callback factories
export type {
  RouteUseItem,
  LayoutUseItem,
  AllUseItems,
  UseItems,
} from "./route-types.js";

// Handle API
export { createHandle, isHandle, type Handle } from "./handle.js";

// Pre-render handler API
export {
  Prerender,
  isPrerenderHandler,
  type PrerenderHandlerDefinition,
  type PrerenderOptions,
  type BuildContext,
} from "./prerender.js";

// Static handler API
export {
  Static,
  isStaticHandler,
  type StaticHandlerDefinition,
} from "./static-handler.js";

// Django-style URL patterns (RSC/server context)
export {
  urls,
  RESPONSE_TYPE,
  type PathHelpers,
  type PathOptions,
  type UrlPatterns,
  type IncludeOptions,
  type IncludeItem,
  type RouteResponse,
  type ResponseError,
  type ResponseEnvelope,
  type ResponseHandler,
  type ResponseHandlerContext,
  type JsonResponseHandler,
  type TextResponseHandler,
  type JsonValue,
  type ResponsePathFn,
  type JsonResponsePathFn,
  type TextResponsePathFn,
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
export {
  getRequestContext,
  requireRequestContext,
  type RequestContext,
} from "./server/request-context.js";

// Meta types
export type { MetaDescriptor, MetaDescriptorBase } from "./router/types.js";

// Middleware context types
export type {
  MiddlewareContext,
  CookieOptions,
} from "./router/middleware.js";

// Reverse type utilities for type-safe URL generation (Django-style URL reversal)
export type { ScopedReverseFunction, ReverseFunction, ExtractLocalRoutes, PrefixedRoutes, PrefixRoutePatterns, ParamsFor, SanitizePrefix, MergeRoutes } from "./reverse.js";
export { scopedReverse, createReverse } from "./reverse.js";

// Search params schema types
export type { SearchSchema, SearchSchemaValue, ResolveSearchSchema, RouteSearchParams, RouteParams } from "./search-params.js";

// Performance tracking (server-only)
export { track } from "./server/context.js";

// Debug utilities for route matching (development only)
export {
  enableMatchDebug,
  getMatchDebugStats,
} from "./router/pattern-matching.js";

// Location state (universal)
export {
  createLocationState,
  type LocationStateDefinition,
  type LocationStateEntry,
  type LocationStateOptions,
} from "./browser/react/location-state-shared.js";

// Path-based response type lookup from RegisteredRoutes
export type { PathResponse } from "./href-client.js";
