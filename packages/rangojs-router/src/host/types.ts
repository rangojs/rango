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
 * Result from testing a hostname against patterns
 */
export interface HostMatchResult {
  pattern: string;
  handler: Handler | LazyHandler;
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
   * Map to a handler or lazy import
   */
  map(handler: Handler | LazyHandler): HostRouter;
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
   * Test which handler would match a hostname
   */
  test(hostname: string): HostMatchResult | null;
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
  isFallback?: boolean;
}

/**
 * Pattern match result (internal)
 */
export interface PatternMatchResult {
  matched: boolean;
  routeEntry?: RouteEntry;
}
