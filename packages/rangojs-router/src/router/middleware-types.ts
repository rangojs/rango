/**
 * Middleware Types
 *
 * Type definitions and interfaces for the middleware system.
 * Separated from execution logic for cleaner imports.
 */

import type { ContextVar } from "../context-var.js";
import type {
  DefaultReverseRouteMap,
  DefaultRouteName,
  DefaultVars,
} from "../types/global-namespace.js";
import type { ScopedReverseFunction } from "../reverse.js";
import type { Theme } from "../theme/types.js";
import type { LocationStateEntry } from "../browser/react/location-state-shared.js";
import type { RequestScope } from "../types/request-scope.js";

/**
 * Get variable function type
 */
type GetVariableFn = {
  <T>(contextVar: ContextVar<T>): T | undefined;
  <K extends keyof DefaultVars>(key: K): DefaultVars[K];
};

/**
 * Set variable function type
 */
type SetVariableFn = {
  <T>(contextVar: ContextVar<T>, value: T, options?: { cache?: boolean }): void;
  <K extends keyof DefaultVars>(
    key: K,
    value: DefaultVars[K],
    options?: { cache?: boolean },
  ): void;
};

/**
 * Cookie options for setting cookies
 */
export interface CookieOptions {
  domain?: string;
  path?: string;
  maxAge?: number;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "strict" | "lax" | "none";
}

/**
 * Context passed to middleware
 *
 * @template TEnv - Environment type (bindings, variables) - defaults to any for internal flexibility
 * @template TParams - URL params type (typed for route middleware,
 *   `Record<string, string | undefined>` for global middleware — absent
 *   optional segments are omitted from the params record at runtime, so
 *   the index signature must include `undefined`)
 */
export interface MiddlewareContext<
  TEnv = any,
  TParams = Record<string, string | undefined>,
> extends RequestScope<TEnv> {
  /** URL params extracted from route/middleware pattern */
  params: TParams;

  /**
   * Response headers.
   * Before `next()`, returns headers from the shared response stub.
   * After `next()`, returns headers from the downstream response.
   */
  readonly headers: Headers;

  /** Get a context variable (shared with route handlers) */
  get: GetVariableFn;

  /** Set a context variable (shared with route handlers) */
  set: SetVariableFn;

  /**
   * Set a response header - can be called before or after `next()`.
   *
   * When called before `next()`, headers are queued and merged into the final response.
   * When called after `next()`, headers are set directly on the response.
   */
  header(name: string, value: string): void;

  /**
   * The matched route name, if available and the route has an explicit name.
   * Undefined for global middleware (runs before route matching) or unnamed routes.
   */
  routeName?: DefaultRouteName;

  /**
   * Enable performance metrics for this request.
   * When called, granular timing breakdown is logged to console and
   * included in the Server-Timing response header, regardless of the
   * router-level `debugPerformance` option.
   *
   * Call **before** `await next()` so the metrics store exists when
   * downstream phases (route matching, rendering, SSR) record their
   * spans. Calling after `next()` returns still emits `handler:total`
   * but misses all upstream metrics.
   */
  debugPerformance(): void;

  /**
   * Current theme (from cookie or default).
   * Only available when theme is enabled in router config.
   */
  theme?: Theme;

  /**
   * Set the theme (only available when theme is enabled in router config).
   * Sets a cookie with the new theme value.
   */
  setTheme?: (theme: Theme) => void;

  /**
   * Attach location state entries to this response.
   * State is delivered to the client via history.pushState and accessible
   * through the useLocationState() hook.
   */
  setLocationState(entries: LocationStateEntry | LocationStateEntry[]): void;

  /**
   * Generate URLs from route names.
   * - `name` — global route, from the named-routes definition
   */
  reverse: ScopedReverseFunction<
    Record<string, string>,
    DefaultReverseRouteMap
  >;
}

/**
 * Middleware function signature
 *
 * @template TEnv - Environment type - defaults to any for internal flexibility
 * @template TParams - URL params type (typed for route middleware)
 *
 * When using middleware with global augmentation (RSCRouter.Env), explicitly
 * annotate your middleware functions, or the types will be inferred from context:
 *
 * @example
 * ```typescript
 * // With explicit annotation (recommended for reusable middleware)
 * const authMiddleware: MiddlewareFn<AppEnv> = async (ctx, next) => {...}
 *
 * // Types inferred from router.use() call
 * router.use((ctx, next) => {...}) // ctx is typed from router's TEnv
 * ```
 */
export type MiddlewareFn<
  TEnv = any,
  TParams = Record<string, string | undefined>,
> = (
  ctx: MiddlewareContext<TEnv, TParams>,
  next: () => Promise<Response>,
) => Response | void | Promise<Response | void>;

/**
 * Stored middleware entry with pattern matching info
 * @internal - uses any for internal flexibility
 */
export interface MiddlewareEntry<TEnv = any> {
  /** Original pattern string */
  pattern: string | null;

  /** Compiled regex for matching */
  regex: RegExp | null;

  /** Param names extracted from pattern */
  paramNames: string[];

  /** The middleware function */
  handler: MiddlewareFn<TEnv>;

  /** Mount prefix this middleware is scoped to (null = global) */
  mountPrefix: string | null;
}

/**
 * Mutable response holder - tracks the current response through the middleware chain.
 */
export interface ResponseHolder {
  response: Response | null;
}

/**
 * Entry type for middleware collection
 * Matches the shape of EntryData used in router.ts
 */
export interface MiddlewareCollectableEntry {
  middleware?: MiddlewareFn<any, any>[];
  layout?: MiddlewareCollectableEntry[];
}

/**
 * Collected route middleware with params
 */
export interface CollectedMiddleware {
  handler: MiddlewareFn<any, any>;
  // Internal shape only. The user-facing `MiddlewareContext.params` is
  // typed `Record<string, string | undefined>` to reflect that absent
  // optional segments are omitted from the params record at runtime.
  params: Record<string, string>;
}
