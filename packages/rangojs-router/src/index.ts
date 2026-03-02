/**
 * @rangojs/router
 *
 * Single user-facing entrypoint for all router APIs.
 *
 * The "react-server" export condition selects index.rsc.ts (real implementations)
 * vs this file (client stubs for server-only functions).
 *
 * For client-only exports (Outlet, useOutlet, hooks, components):
 *   import from "@rangojs/router/client"
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
  Skip,
  isSkip,
} from "./errors.js";

// Types (safe to import anywhere - no runtime code)
export type {
  // Configuration types
  DocumentProps,
  DefaultEnv,
  RouteDefinition,
  RouteConfig,
  RouteDefinitionOptions,
  TrailingSlashMode,
  // Handler types
  Handler, // Supports params object, path pattern, or route name
  ScopedRouteMap, // Scoped view of GeneratedRouteMap for Handler<"localName", ScopedRouteMap<"prefix">>
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

// Search params schema types
export type {
  SearchSchema,
  SearchSchemaValue,
  ResolveSearchSchema,
  RouteSearchParams,
  RouteParams,
} from "./search-params.js";

// Client-safe createLoader - only stores the $$id, function is not included
// Use this when defining loaders that will be imported by client components
export { createLoader } from "./loader.js";

// Route definition types (safe to import anywhere)
export type { RouteHelpers, RouteHandlers } from "./route-definition.js";
export type { TransitionConfig, ViewTransitionClass } from "./types.js";

// Composition types for reusable callback factories
export type {
  RouteUseItem,
  LayoutUseItem,
  AllUseItems,
  UseItems,
} from "./route-types.js";

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

// Middleware context types
export type { MiddlewareContext, CookieOptions } from "./router/middleware.js";

/**
 * Error-throwing stub for server-only `urls` function.
 */
export function urls(): never {
  throw new Error("urls() is server-only and requires RSC context.");
}

/**
 * Error-throwing stub for server-only `createRouter` function.
 */
export function createRouter(): never {
  throw new Error("createRouter() is server-only and requires RSC context.");
}

/**
 * Error-throwing stub for server-only `redirect` function.
 */
export function redirect(): never {
  throw new Error("redirect() is server-only and requires RSC context.");
}

// Handle API (universal - works on both server and client)
export { createHandle, isHandle, type Handle } from "./handle.js";

// Context variable API (typed ctx.set/ctx.get tokens)
export { createVar, type ContextVar } from "./context-var.js";

// CSP nonce token (use with ctx.get(nonce) in middleware/handlers)
export { nonce } from "./rsc/nonce.js";

/**
 * Error-throwing stub for server-only `Prerender` function.
 */
export function Prerender(): never {
  throw new Error("Prerender() is server-only and requires RSC context.");
}

/**
 * Error-throwing stub for server-only `Static` function.
 */
export function Static(): never {
  throw new Error("Static() is server-only and requires RSC context.");
}

/**
 * Error-throwing stub for server-only `getRequestContext` function.
 */
export function getRequestContext(): never {
  throw new Error(
    "getRequestContext() is server-only and requires RSC context.",
  );
}

/**
 * Error-throwing stub for server-only `createReverse` function.
 */
export function createReverse(): never {
  throw new Error("createReverse() is server-only and requires RSC context.");
}

/**
 * Error-throwing stub for server-only `enableMatchDebug` function.
 */
export function enableMatchDebug(): never {
  throw new Error(
    "enableMatchDebug() is server-only and requires RSC context.",
  );
}

/**
 * Error-throwing stub for server-only `getMatchDebugStats` function.
 */
export function getMatchDebugStats(): never {
  throw new Error(
    "getMatchDebugStats() is server-only and requires RSC context.",
  );
}

// Error-throwing stubs for server-only route helpers
export function layout(): never {
  throw new Error("layout() is server-only and requires RSC context.");
}
export function cache(): never {
  throw new Error("cache() is server-only and requires RSC context.");
}
export function middleware(): never {
  throw new Error("middleware() is server-only and requires RSC context.");
}
export function revalidate(): never {
  throw new Error("revalidate() is server-only and requires RSC context.");
}
export function loader(): never {
  throw new Error("loader() is server-only and requires RSC context.");
}
export function loading(): never {
  throw new Error("loading() is server-only and requires RSC context.");
}
export function parallel(): never {
  throw new Error("parallel() is server-only and requires RSC context.");
}
export function intercept(): never {
  throw new Error("intercept() is server-only and requires RSC context.");
}
export function when(): never {
  throw new Error("when() is server-only and requires RSC context.");
}
export function errorBoundary(): never {
  throw new Error("errorBoundary() is server-only and requires RSC context.");
}
export function notFoundBoundary(): never {
  throw new Error(
    "notFoundBoundary() is server-only and requires RSC context.",
  );
}
export function transition(): never {
  throw new Error("transition() is server-only and requires RSC context.");
}

// Request context type (safe for client)
export type { RequestContext } from "./server/request-context.js";

// Meta types
export type { MetaDescriptor, MetaDescriptorBase } from "./router/types.js";

// Reverse type utilities for type-safe URL generation (Django-style URL reversal)
export type {
  ScopedReverseFunction,
  ReverseFunction,
  ExtractLocalRoutes,
  ParamsFor,
  SanitizePrefix,
  MergeRoutes,
} from "./reverse.js";
// scopedReverse() helper for handlers to get locally-typed reverse
export { scopedReverse } from "./reverse.js";

// Location state (universal - works on both server and client)
export {
  createLocationState,
  type LocationStateDefinition,
  type LocationStateEntry,
  type LocationStateOptions,
} from "./browser/react/location-state-shared.js";

// Path-based response type lookup from RegisteredRoutes
export type { PathResponse } from "./href-client.js";
