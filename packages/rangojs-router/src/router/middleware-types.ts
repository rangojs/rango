/**
 * Middleware Types
 *
 * Type definitions and interfaces for the middleware system.
 * Separated from execution logic for cleaner imports.
 */

import type { ContextVar } from "../context-var.js";
import type {
  DefaultReverseRouteMap,
  DefaultVars,
} from "../types/global-namespace.js";
import type { ScopedReverseFunction } from "../reverse.js";

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
  <T>(contextVar: ContextVar<T>, value: T): void;
  <K extends keyof DefaultVars>(key: K, value: DefaultVars[K]): void;
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
 * @template TParams - URL params type (typed for route middleware, Record<string, string> for global middleware)
 */
export interface MiddlewareContext<
  TEnv = any,
  TParams = Record<string, string>,
> {
  /** Original request */
  request: Request;

  /** Parsed URL */
  url: URL;

  /** URL pathname */
  pathname: string;

  /** URL search params */
  searchParams: URLSearchParams;

  /** Platform bindings (Cloudflare, etc.) */
  env: TEnv;

  /** URL params extracted from route/middleware pattern */
  params: TParams;

  /**
   * Response stub (read-only). Before `next()`, returns the shared response stub
   * where headers and cookies accumulate. After `next()`, returns the downstream response.
   *
   * Use `ctx.header()`, `ctx.setCookie()`, or `ctx.deleteCookie()` to mutate.
   * To replace the response entirely, return a new `Response` from the middleware.
   */
  readonly res: Response;

  /** Get a cookie value */
  cookie(name: string): string | undefined;

  /** Get all cookies as object */
  cookies(): Record<string, string>;

  /** Set a cookie on the response */
  setCookie(name: string, value: string, options?: CookieOptions): void;

  /** Delete a cookie */
  deleteCookie(
    name: string,
    options?: Pick<CookieOptions, "domain" | "path">,
  ): void;

  /** Get a context variable (shared with route handlers) */
  get: GetVariableFn;

  /** Set a context variable (shared with route handlers) */
  set: SetVariableFn;

  /**
   * Set a response header - can be called before or after `next()`
   *
   * When called before `next()`, headers are queued and merged into the final response.
   * When called after `next()`, headers are set directly on the response.
   * Shorthand for `ctx.res.headers.set()`.
   */
  header(name: string, value: string): void;

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
export type MiddlewareFn<TEnv = any, TParams = Record<string, string>> = (
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
 * Mutable response holder - allows ctx.res to be updated after next() is called
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
  params: Record<string, string>;
}
