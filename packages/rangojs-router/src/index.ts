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
  DslContextError,
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
  ActionRef,
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

// Universal cache-key filtering config and tracking-param preset.
export {
  TRACKING_SEARCH_PARAMS,
  type CacheSearchParams,
} from "./cache/search-params-filter.js";

// Client-safe createLoader - only stores the $$id, function is not included
// Use this when defining loaders that will be imported by client components
export { createLoader } from "./loader.js";

// Route definition types (safe to import anywhere)
export type { RouteHelpers, RouteHandlers } from "./route-definition.js";
export type {
  TransitionConfig,
  TransitionWhenFn,
  TransitionWhenContext,
  ViewTransitionClass,
} from "./types.js";

// Composition types for reusable callback factories
export type {
  RouteUseItem,
  LayoutUseItem,
  AllUseItems,
  UseItems,
  HandlerUseItem,
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
  ProblemDetails,
  PartialPrerenderProps,
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
export {
  DEFAULT_DEFER_TIMEOUT_MS,
  type DeferOptions,
  type HandlePush,
  type HandlePushFn,
} from "./defer.js";

// Context variable API (typed ctx.set/ctx.get tokens)
export { createVar, type ContextVar } from "./context-var.js";

// CSP nonce token (use with ctx.get(nonce) in middleware/handlers)
export { nonce } from "./rsc/nonce.js";

/**
 * SSR/client stub for server-only `Prerender` function.
 *
 * Returns a lightweight stub object instead of throwing so that the
 * production SSR build can safely bundle the RSC entry chunk — the SSR
 * bundler resolves `@rangojs/router` to this (SSR) entry, so Prerender
 * calls in RSC code must not crash at module-evaluation time.
 */
export function Prerender(
  _handler?: any,
  _optionsOrId?: any,
  __injectedId?: string,
): any {
  const id =
    typeof _optionsOrId === "string" ? _optionsOrId : __injectedId || "";
  return { __brand: "prerenderHandler" as const, $$id: id };
}

/**
 * SSR/client stub for server-only `Passthrough` function.
 */
export function Passthrough(
  _handler?: any,
  _optionsOrId?: any,
  __injectedId?: string,
): any {
  const id =
    typeof _optionsOrId === "string" ? _optionsOrId : __injectedId || "";
  return { __brand: "passthroughHandler" as const, $$id: id };
}

/**
 * SSR/client stub for server-only `Static` function.
 *
 * Returns a lightweight stub object instead of throwing so that the
 * production SSR build can safely bundle the RSC entry chunk — the SSR
 * bundler resolves `@rangojs/router` to this (SSR) entry, so Static
 * calls in RSC code must not crash at module-evaluation time.
 */
export function Static(
  _handler?: any,
  _optionsOrId?: any,
  __injectedId?: string,
): any {
  const id =
    typeof _optionsOrId === "string" ? _optionsOrId : __injectedId || "";
  return { __brand: "staticHandler" as const, $$id: id };
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
 * Client implementation of `invalidateClientCache()`. Unlike the server-only
 * stubs above this is a REAL function under the `default` condition (it marks
 * the client's caches stale); the `react-server` condition (index.rsc.ts)
 * selects the server implementation that writes a rotated `Set-Cookie`.
 */
export {
  invalidateClientCache,
  keepClientCache,
} from "./browser/invalidate-client-cache.js";

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
// Cache tag APIs are server-only (real implementations in index.rsc.ts). These
// stubs keep the named-export shape identical under the default/non-react-server
// condition so SSR/client/default bundles that encounter the import link cleanly.
export function cacheTag(): never {
  throw serverOnlyStubError("cacheTag");
}
export function updateTag(): never {
  throw serverOnlyStubError("updateTag");
}
export function revalidateTag(): never {
  throw serverOnlyStubError("revalidateTag");
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

// Shared base for every user-facing request context.
export type { RequestScope, ExecutionContext } from "./types/request-scope.js";

// Cookie store types (safe for client)
export type {
  CookieStore,
  Cookie,
  ReadonlyHeaders,
} from "./server/cookie-store.js";

// Built-in handles (universal — work on both server and client)
export { Meta } from "./handles/meta.js";
export {
  Script,
  type ScriptConfig,
  type ScriptAttributes,
} from "./handles/script.js";
export { Breadcrumbs } from "./handles/breadcrumbs.js";

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

// Path and response types are ambient on the `Rango` namespace (`Rango.Path`,
// `Rango.PathResponse`, declared in href-client.ts) — no import needed.

// Telemetry types only — the createConsoleSink / createOTelSink /
// createOTelTracing VALUES are server-only and live in index.rsc.ts (the
// `react-server` condition of the bare `@rangojs/router` import). Re-exporting
// them as values from this (default/client) entry would pull telemetry.ts and
// telemetry-otel.ts into the client module graph; both tree-shake to zero bytes
// but still appear in bundle analysis output and slow build-time module
// resolution. The factory values are NOT re-exported from `@rangojs/router/server`
// either — that subpath is internal, not user-facing (see server.ts header).
// Non-RSC server code imports these TYPES from the root and obtains the factory
// VALUES from its own router definition module, which resolves to index.rsc.ts
// under the `react-server` condition.
export type {
  OTelTracer,
  OTelActiveSpanTracer,
  OTelSpan,
  OTelTracingOptions,
} from "./router/telemetry-otel.js";
// The full TelemetryEvent union PLUS its member types, so a consumer writing a
// TelemetrySink can annotate a per-`type` handler (or construct an event literal
// in a test) instead of only narrowing the opaque union.
export type {
  TelemetrySink,
  TelemetryEvent,
  RequestStartEvent,
  RequestEndEvent,
  RequestErrorEvent,
  LoaderStartEvent,
  LoaderEndEvent,
  LoaderErrorEvent,
  HandlerErrorEvent,
  CacheSegmentStatus,
  CacheSegmentSignal,
  CacheDecisionEvent,
  RevalidationDecisionEvent,
  RequestTimeoutEvent,
  OriginCheckRejectedEvent,
} from "./router/telemetry.js";

// Span tracing config types a consumer annotates. SpanRunner/TraceSpan are the
// internal runner contract (consumers go through createOTelTracing /
// createCloudflareTracing, which return a ready RouterTracingConfig) and are not
// exported.
export type {
  RouterTracingConfig,
  TracePhase,
  TracePhaseToggles,
  TracingToggleOptions,
} from "./router/tracing.js";

// Timeout types and error class
export { RouterTimeoutError } from "./router/timeout.js";
export type {
  RouterTimeouts,
  TimeoutPhase,
  TimeoutContext,
  RenderTimeoutContext,
} from "./router/timeout.js";
