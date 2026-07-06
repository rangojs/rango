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
  // Error classes
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
} from "./index.js";

// Re-export all types from types.ts (user-facing types only)
export type {
  // Configuration types
  DocumentProps,
  DefaultEnv,
  RouteDefinition,
  RouteConfig,
  RouteDefinitionOptions,
  TrailingSlashMode,
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
  // View transition types (also exported from the default entry; route
  // definitions resolve to this react-server entry, so they must be here too)
  TransitionConfig,
  TransitionWhenFn,
  TransitionWhenContext,
  ViewTransitionClass,
} from "./types.js";

// Router options type (server-only, so import directly)
export type {
  RangoOptions,
  SSRStreamMode,
  SSROptions,
  ResolveStreamingContext,
} from "./router.js";

// Origin-check callback types (referenced by the RangoOptions.originCheck JSDoc)
export type {
  OriginCheckConfig,
  OriginCheckContext,
  OriginCheckPhase,
} from "./rsc/origin-guard.js";

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
  errorBoundary,
  notFoundBoundary,
  transition,
} from "./route-definition.js";

// Composition types for reusable callback factories
export type {
  RouteUseItem,
  LayoutUseItem,
  AllUseItems,
  UseItems,
  HandlerUseItem,
} from "./route-types.js";

// Handle API
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

// Pre-render handler API
export {
  Prerender,
  Passthrough,
  type PrerenderHandlerDefinition,
  type PassthroughHandlerDefinition,
  type PrerenderOptions,
  type BuildContext,
  type StaticBuildContext,
  type GetParamsContext,
  type PrerenderPassthroughResult,
} from "./prerender.js";

// Static handler API
export {
  Static,
  type StaticHandlerDefinition,
  type StaticHandlerOptions,
} from "./static-handler.js";

// Django-style URL patterns (RSC/server context)
export {
  urls,
  type PathHelpers,
  type PathOptions,
  type PartialPrerenderProps,
  type UrlPatterns,
  type IncludeOptions,
  type IncludeItem,
  type RouteResponse,
  type ProblemDetails,
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
  type Rango,
  type RootLayoutProps,
  type RouterRequestInput,
} from "./router.js";

// RSC handler types (server-side)
export type { HandlerCacheConfig } from "./rsc/types.js";

// Built-in handles (server-side)
export { Meta } from "./handles/meta.js";
export {
  Script,
  type ScriptConfig,
  type ScriptAttributes,
} from "./handles/script.js";
export { Breadcrumbs, type BreadcrumbItem } from "./handles/breadcrumbs.js";

// Request context (for accessing request data in server actions/components).
// Re-exported with a narrowed return type so that public consumers only see
// public members. Internal code imports from "./server/request-context.js"
// directly and gets the full type.
import { getRequestContext as _getRequestContextInternal } from "./server/request-context.js";
export type { PublicRequestContext as RequestContext } from "./server/request-context.js";
import type { PublicRequestContext } from "./server/request-context.js";
import type { DefaultEnv } from "./types/global-namespace.js";

// Shared base for every user-facing request context (mirrors index.ts).
export type { RequestScope, ExecutionContext } from "./types/request-scope.js";

export const getRequestContext: <
  TEnv = DefaultEnv,
>() => PublicRequestContext<TEnv> = _getRequestContextInternal;

// Request-scoped shorthands
export {
  cookies,
  headers,
  invalidateClientCache,
  keepClientCache,
  type CookieStore,
  type Cookie,
  type ReadonlyHeaders,
} from "./server/cookie-store.js";

// Cache tag APIs (server-only)
// cacheTag: tag the current "use cache" entry at runtime.
// updateTag: read-your-own-writes invalidation (awaitable, for Server Actions).
// revalidateTag: background hard-purge invalidation (not awaited, for route handlers / webhooks).
export { cacheTag } from "./cache/cache-tag.js";
export { updateTag, revalidateTag } from "./cache/tag-invalidation.js";

// Meta types
export type { MetaDescriptor, MetaDescriptorBase } from "./router/types.js";

// Middleware context types
export type {
  MiddlewareContext,
  CookieOptions,
  // The function type of a middleware. Public so the documented "extract the
  // middleware and unit-test it with runMiddleware" pattern has a nameable type.
  MiddlewareFn,
} from "./router/middleware.js";

// Reverse type utilities for type-safe URL generation (Django-style URL reversal)
export type {
  ScopedReverseFunction,
  ReverseFunction,
  ExtractLocalRoutes,
  ParamsFor,
} from "./reverse.js";
export { scopedReverse, createReverse } from "./reverse.js";

// Search params schema types
export type {
  SearchSchema,
  SearchSchemaValue,
  ResolveSearchSchema,
  RouteSearchParams,
  RouteParams,
} from "./search-params.js";

// Location state (universal)
export {
  createLocationState,
  type LocationStateDefinition,
  type LocationStateEntry,
  type LocationStateOptions,
} from "./browser/react/location-state-shared.js";

// Path and response types are ambient on the `Rango` namespace (`Rango.Path`,
// `Rango.PathResponse`, declared in href-client.ts) — no import needed.

// Telemetry sink (event-shaped facts)
export { createConsoleSink } from "./router/telemetry.js";
export { createOTelSink } from "./router/telemetry-otel.js";
// OTel phase-span adapter for the `tracing` slot (the canonical span layer).
export { createOTelTracing } from "./router/telemetry-otel.js";
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
} from "./router/timeout.js";
