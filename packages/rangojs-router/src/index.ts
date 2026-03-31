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

// Error classes (can be used on both server and client)
export {
  RouteNotFoundError,
  DataNotFoundError,
  notFound,
  MiddlewareError,
  HandlerError,
  BuildError,
  InvalidHandlerError,
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

function serverOnlyStubError(name: string): Error {
  return new Error(
    `${name}() is only available from "@rangojs/router" in a react-server/RSC environment. ` +
      `For client hooks and components, import from "@rangojs/router/client".`,
  );
}

/**
 * Error-throwing stub for server-only `urls` function.
 */
export function urls(): never {
  throw serverOnlyStubError("urls");
}

/**
 * Error-throwing stub for server-only `createRouter` function.
 */
export function createRouter(): never {
  throw serverOnlyStubError("createRouter");
}

/**
 * Error-throwing stub for server-only `redirect` function.
 */
export function redirect(): never {
  throw serverOnlyStubError("redirect");
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
  throw serverOnlyStubError("Prerender");
}

/**
 * Error-throwing stub for server-only `Passthrough` function.
 */
export function Passthrough(): never {
  throw serverOnlyStubError("Passthrough");
}

/**
 * Error-throwing stub for server-only `Static` function.
 */
export function Static(): never {
  throw serverOnlyStubError("Static");
}

/**
 * Error-throwing stub for server-only `getRequestContext` function.
 */
export function getRequestContext(): never {
  throw serverOnlyStubError("getRequestContext");
}

/**
 * Error-throwing stub for server-only `cookies` function.
 */
export function cookies(): never {
  throw serverOnlyStubError("cookies");
}

/**
 * Error-throwing stub for server-only `headers` function.
 */
export function headers(): never {
  throw serverOnlyStubError("headers");
}

/**
 * Error-throwing stub for server-only `createReverse` function.
 */
export function createReverse(): never {
  throw serverOnlyStubError("createReverse");
}

// Error-throwing stubs for server-only route helpers
export function layout(): never {
  throw serverOnlyStubError("layout");
}
export function cache(): never {
  throw serverOnlyStubError("cache");
}
export function middleware(): never {
  throw serverOnlyStubError("middleware");
}
export function revalidate(): never {
  throw serverOnlyStubError("revalidate");
}
export function loader(): never {
  throw serverOnlyStubError("loader");
}
export function loading(): never {
  throw serverOnlyStubError("loading");
}
export function parallel(): never {
  throw serverOnlyStubError("parallel");
}
export function intercept(): never {
  throw serverOnlyStubError("intercept");
}
export function when(): never {
  throw serverOnlyStubError("when");
}
export function errorBoundary(): never {
  throw serverOnlyStubError("errorBoundary");
}
export function notFoundBoundary(): never {
  throw serverOnlyStubError("notFoundBoundary");
}
export function transition(): never {
  throw serverOnlyStubError("transition");
}

// Request context type (safe for client)
export type { PublicRequestContext as RequestContext } from "./server/request-context.js";

// Cookie store types (safe for client)
export type {
  CookieStore,
  Cookie,
  ReadonlyHeaders,
} from "./server/cookie-store.js";

// Meta types
export type { MetaDescriptor, MetaDescriptorBase } from "./router/types.js";

// Breadcrumb types
export type { BreadcrumbItem } from "./handles/breadcrumbs.js";

// Reverse type utilities for type-safe URL generation (Django-style URL reversal)
export type {
  ScopedReverseFunction,
  ReverseFunction,
  ExtractLocalRoutes,
  ParamsFor,
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

// Telemetry sink
export { createConsoleSink } from "./router/telemetry.js";
export { createOTelSink } from "./router/telemetry-otel.js";
export type { OTelTracer, OTelSpan } from "./router/telemetry-otel.js";
export type { TelemetrySink, TelemetryEvent } from "./router/telemetry.js";

// Timeout types and error class
export { RouterTimeoutError } from "./router/timeout.js";
export type {
  RouterTimeouts,
  TimeoutPhase,
  TimeoutContext,
} from "./router/timeout.js";
