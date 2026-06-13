/**
 * Host Router Types
 *
 * Type definitions for the host-based routing system.
 */

import type { RouterRequestInput } from "../router/router-interfaces.js";

/**
 * Handler function that processes a request and returns a response.
 * The input parameter receives the same RouterRequestInput passed to match().
 */
export type Handler = (
  request: Request,
  input: RouterRequestInput<any>,
) => Response | Promise<Response>;

/**
 * Lazy handler that dynamically imports a module with a default handler or router
 */
export type LazyHandler = () => Promise<{ default: Handler | HostRouter }>;

/**
 * Middleware function that can intercept and modify requests/responses.
 * The input parameter receives the same RouterRequestInput passed to match().
 */
export type Middleware = (
  request: Request,
  input: RouterRequestInput<any>,
  next: () => Promise<Response>,
) => Promise<Response>;

/**
 * Host pattern - can be a string or array of strings
 */
export type HostPattern = string | string[];

/**
 * Whether a route entry is an inline request handler or a lazy module mount.
 *
 * Stored on the entry so discovery and runtime act on the consumer's declared
 * intent instead of inferring it from the function's shape (arity/return value),
 * which is ambiguous: a lazy loader may declare an ignored param, and an inline
 * handler may be async. `.map()` registers `"handler"`, `.lazy()` registers
 * `"lazy"`.
 */
export type RouteEntryKind = "handler" | "lazy";

/**
 * Result from testing a hostname against patterns
 */
export interface HostMatchResult {
  pattern: string;
  handler: Handler | LazyHandler;
  kind: RouteEntryKind;
}

/**
 * Host route builder for chaining middleware and handler
 */
export interface HostRouteBuilder {
  /**
   * Add middleware to this host pattern
   */
  use(...middleware: Middleware[]): HostRouteBuilder;

  /**
   * Map to an inline request handler `(request, input) => Response`.
   *
   * For a lazily-imported sub-app or handler module, use {@link lazy} instead -
   * `.map(() => import(...))` is rejected (the return type is not a `Response`)
   * and would not be discovered at build time.
   */
  map(handler: Handler): HostRouter;

  /**
   * Mount a lazily-imported handler or host router:
   * `.lazy(() => import("./sub-app"))`.
   *
   * The loader takes no arguments and resolves to a module whose `default`
   * export is a request `Handler` or a nested `HostRouter`. Only `.lazy()`
   * entries are invoked during build-time discovery to trigger the sub-app's
   * `createRouter()` registration.
   */
  lazy(handler: LazyHandler): HostRouter;
}

/**
 * Main host router interface
 */
export interface HostRouter {
  /**
   * Register a host pattern
   */
  host(patterns: HostPattern): HostRouteBuilder;

  /**
   * Register global middleware
   */
  use(...middleware: Middleware[]): HostRouter;

  /**
   * Match an incoming request
   */
  match(request: Request, input?: RouterRequestInput<any>): Promise<Response>;

  /**
   * Register fallback handler for allowed hosts without valid cookie
   */
  fallback(): HostRouteBuilder;

  /**
   * Test which handler would match a hostname (and optional pathname).
   *
   * `pathname` defaults to `"/"`. Pass it to probe path-prefixed patterns
   * such as `host(["example.com/admin"])`, which only match when the request
   * path is under the prefix.
   */
  test(hostname: string, pathname?: string): HostMatchResult | null;
}

/**
 * Host override configuration
 */
export interface HostOverrideConfig {
  /**
   * Cookie name to read for host override
   */
  cookieName: string;

  /**
   * Hosts that are allowed to use override
   */
  allowedHosts: string[];

  /**
   * Optional validation function
   */
  validate?: (
    request: Request,
    cookieValue: string,
    input: RouterRequestInput<any>,
  ) => string;
}

/**
 * Host router options
 */
export interface HostRouterOptions {
  /**
   * Enable debug logging
   */
  debug?: boolean;

  /**
   * Cookie-based host override configuration
   */
  hostOverride?: HostOverrideConfig;
}

/**
 * Internal route entry
 */
export interface RouteEntry {
  patterns: string[];
  middleware: Middleware[];
  handler: Handler | LazyHandler;
  /** Whether `handler` is an inline request handler or a lazy module mount. */
  kind: RouteEntryKind;
  isFallback?: boolean;
}

/**
 * Pattern match result (internal)
 */
export interface PatternMatchResult {
  matched: boolean;
  routeEntry?: RouteEntry;
}
