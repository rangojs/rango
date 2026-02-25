/// <reference types="vite/types/importMeta.d.ts" />
/**
 * Middleware Execution
 *
 * True middleware that wraps the entire RSC handler.
 * - `await next()` returns actual Response
 * - Can modify response headers
 * - Can catch errors from RSC rendering
 * - Forgiving API: if middleware doesn't return, original response is used
 */

import type { RouterEnv } from "../types.js";
import { type ContextVar, contextGet, contextSet } from "../context-var.js";

/**
 * Helper type to extract Variables from RouterEnv
 * Uses 0 extends 1 & TEnv to detect `any` type and fall back to Record<string, unknown>
 */
type ExtractVariables<TEnv> = 0 extends 1 & TEnv
  ? Record<string, unknown> // TEnv is any
  : TEnv extends RouterEnv<unknown, infer V>
    ? V
    : Record<string, unknown>;

/**
 * Get variable function type
 */
type GetVariableFn<TEnv> = {
  <T>(contextVar: ContextVar<T>): T | undefined;
  <K extends keyof ExtractVariables<TEnv>>(key: K): ExtractVariables<TEnv>[K];
};

/**
 * Set variable function type
 */
type SetVariableFn<TEnv> = {
  <T>(contextVar: ContextVar<T>, value: T): void;
  <K extends keyof ExtractVariables<TEnv>>(
    key: K,
    value: ExtractVariables<TEnv>[K],
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
  env: TEnv extends RouterEnv<infer B, unknown> ? B : {};

  /** URL params extracted from route/middleware pattern */
  params: TParams;

  /**
   * Response object - available immediately via stub, real response after `await next()`
   *
   * Headers set before `next()` are merged into the final response.
   * Can be used to modify headers directly like Hono's `c.res`.
   *
   * @example
   * ```typescript
   * middleware(async (ctx, next) => {
   *   // Set headers BEFORE next() - will be merged into final response
   *   ctx.res.headers.set('X-Request-Id', generateId());
   *
   *   await next();
   *
   *   // Set headers AFTER next() - applied directly
   *   ctx.res.headers.set('X-Custom', 'value');
   *   // No return needed!
   * });
   * ```
   */
  res: Response;

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
  get: GetVariableFn<TEnv>;

  /** Set a context variable (shared with route handlers) */
  set: SetVariableFn<TEnv>;

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
  reverse(
    name: string,
    params?: Record<string, string>,
    search?: Record<string, unknown>,
  ): string;
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
 * Parse a route pattern into regex and param names
 * Supports: *, /path, /path/*, /path/:param, /path/:param/*
 */
export function parsePattern(pattern: string): {
  regex: RegExp;
  paramNames: string[];
} {
  if (pattern === "*") {
    return { regex: /^.*$/, paramNames: [] };
  }

  const paramNames: string[] = [];
  let regexStr = "^";

  const parts = pattern.split("/").filter(Boolean);

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    if (part === "*") {
      // Wildcard - match rest of path
      regexStr += "(?:/.*)?";
    } else if (part.startsWith(":")) {
      // Param
      const paramName = part.slice(1);
      paramNames.push(paramName);
      regexStr += "/([^/]+)";
    } else {
      // Literal
      regexStr += "/" + escapeRegex(part);
    }
  }

  // If pattern doesn't end with *, match exact or with trailing segments
  if (!pattern.endsWith("*")) {
    regexStr += "/?$";
  } else {
    regexStr += "$";
  }

  return { regex: new RegExp(regexStr), paramNames };
}

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract params from a pathname using a pattern's regex and param names
 */
export function extractParams(
  pathname: string,
  regex: RegExp,
  paramNames: string[],
): Record<string, string> {
  const match = pathname.match(regex);
  if (!match) return {};

  const params: Record<string, string> = {};
  for (let i = 0; i < paramNames.length; i++) {
    params[paramNames[i]] = match[i + 1] || "";
  }
  return params;
}

/**
 * Parse cookies from Cookie header
 */
export function parseCookies(
  cookieHeader: string | null,
): Record<string, string> {
  if (!cookieHeader) return {};

  const cookies: Record<string, string> = {};
  const pairs = cookieHeader.split(";");

  for (const pair of pairs) {
    const [name, ...rest] = pair.trim().split("=");
    if (name) {
      cookies[name] = decodeURIComponent(rest.join("="));
    }
  }

  return cookies;
}

/**
 * Serialize a cookie for Set-Cookie header
 */
export function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions = {},
): string {
  let cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;

  if (options.domain) cookie += `; Domain=${options.domain}`;
  if (options.path) cookie += `; Path=${options.path}`;
  if (options.maxAge !== undefined) cookie += `; Max-Age=${options.maxAge}`;
  if (options.expires) cookie += `; Expires=${options.expires.toUTCString()}`;
  if (options.httpOnly) cookie += "; HttpOnly";
  if (options.secure) cookie += "; Secure";
  if (options.sameSite) cookie += `; SameSite=${options.sameSite}`;

  return cookie;
}

/**
 * Mutable response holder - allows ctx.res to be updated after next() is called
 */
export interface ResponseHolder {
  response: Response | null;
}

/**
 * Create middleware context
 *
 * Note: The implementation uses runtime values while the interface provides
 * compile-time type safety. The env/get/set types are resolved at call sites
 * via conditional types based on TEnv extending RouterEnv.
 */
export function createMiddlewareContext<TEnv>(
  request: Request,
  env: TEnv,
  params: Record<string, string>,
  variables: Record<string, unknown>,
  responseHolder: ResponseHolder,
  reverse?: (
    name: string,
    params?: Record<string, string>,
    search?: Record<string, unknown>,
  ) => string,
): MiddlewareContext<TEnv> {
  const url = new URL(request.url);
  const cookieHeader = request.headers.get("Cookie");
  let parsedCookies: Record<string, string> | null = null;

  // The runtime implementation - types are enforced at call sites via MiddlewareContext<TEnv>
  return {
    request,
    url,
    pathname: url.pathname,
    searchParams: url.searchParams,
    env: env as MiddlewareContext<TEnv>["env"],
    params,

    // res getter - returns the stub or real response (always available)
    get res(): Response {
      if (!responseHolder.response) {
        throw new Error(
          "ctx.res is not available - responseHolder was not initialized",
        );
      }
      return responseHolder.response;
    },

    // res setter - allows middleware to replace the response
    set res(response: Response) {
      responseHolder.response = response;
    },

    cookie(name: string): string | undefined {
      if (!parsedCookies) {
        parsedCookies = parseCookies(cookieHeader);
      }
      return parsedCookies[name];
    },

    cookies(): Record<string, string> {
      if (!parsedCookies) {
        parsedCookies = parseCookies(cookieHeader);
      }
      return { ...parsedCookies };
    },

    setCookie(name: string, value: string, options?: CookieOptions): void {
      if (!responseHolder.response) {
        throw new Error(
          "ctx.setCookie() is not available - responseHolder was not initialized",
        );
      }
      responseHolder.response.headers.append(
        "Set-Cookie",
        serializeCookie(name, value, options),
      );
    },

    deleteCookie(
      name: string,
      options?: Pick<CookieOptions, "domain" | "path">,
    ): void {
      if (!responseHolder.response) {
        throw new Error(
          "ctx.deleteCookie() is not available - responseHolder was not initialized",
        );
      }
      responseHolder.response.headers.append(
        "Set-Cookie",
        serializeCookie(name, "", { ...options, maxAge: 0 }),
      );
    },

    get: ((keyOrVar: any) =>
      contextGet(variables, keyOrVar)) as MiddlewareContext<TEnv>["get"],

    set: ((keyOrVar: any, value: unknown) => {
      contextSet(variables, keyOrVar, value);
    }) as MiddlewareContext<TEnv>["set"],

    header(name: string, value: string): void {
      if (!responseHolder.response) {
        throw new Error(
          "ctx.header() is not available - responseHolder was not initialized",
        );
      }
      responseHolder.response.headers.set(name, value);
    },

    reverse:
      reverse ??
      ((name: string) => {
        throw new Error(
          `ctx.reverse() is not available - route map was not provided to middleware context`,
        );
      }),
  };
}

/**
 * Match middleware entries against a pathname
 * Returns entries that match, with extracted params
 */
export function matchMiddleware<TEnv>(
  pathname: string,
  entries: MiddlewareEntry<TEnv>[],
): Array<{ entry: MiddlewareEntry<TEnv>; params: Record<string, string> }> {
  const matches: Array<{
    entry: MiddlewareEntry<TEnv>;
    params: Record<string, string>;
  }> = [];

  for (const entry of entries) {
    // No pattern = matches all (global middleware without pattern)
    if (!entry.regex) {
      matches.push({ entry, params: {} });
      continue;
    }

    // Check if pathname matches
    if (entry.regex.test(pathname)) {
      const params = extractParams(pathname, entry.regex, entry.paramNames);
      matches.push({ entry, params });
    }
  }

  return matches;
}

/**
 * Execute middleware chain
 *
 * Features:
 * - `await next()` returns actual Response
 * - `ctx.res` available after `await next()` (like Hono's `c.res`)
 * - `ctx.header()` shorthand for setting headers
 * - Forgiving: if middleware doesn't return, uses `ctx.res`
 * - Short-circuit: return Response to stop chain
 * - Error catching: try/catch around `next()` works
 */
export async function executeMiddleware<TEnv>(
  middlewares: Array<{
    entry: MiddlewareEntry<TEnv>;
    params: Record<string, string>;
  }>,
  request: Request,
  env: TEnv,
  variables: Record<string, any>,
  finalHandler: () => Promise<Response>,
  reverse?: (
    name: string,
    params?: Record<string, string>,
    search?: Record<string, unknown>,
  ) => string,
): Promise<Response> {
  let index = 0;

  // Create a stub response that's available immediately
  // This allows middleware to set headers/cookies before calling next()
  const stubResponse = new Response(null, { status: 200 });
  const responseHolder: ResponseHolder = { response: stubResponse };

  const next = async (): Promise<Response> => {
    if (index >= middlewares.length) {
      // End of chain - call actual RSC handler
      const response = await finalHandler();

      // Merge headers set on stub into the real response
      // Use append for Set-Cookie to preserve multiple cookies
      const mergedHeaders = new Headers(response.headers);
      stubResponse.headers.forEach((value, name) => {
        if (name.toLowerCase() === "set-cookie") {
          mergedHeaders.append(name, value);
        } else {
          mergedHeaders.set(name, value);
        }
      });

      // Clone response with merged headers (mutable for post-next() modifications)
      responseHolder.response = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: mergedHeaders,
      });

      return responseHolder.response;
    }

    const { entry, params } = middlewares[index++];
    const ctx = createMiddlewareContext(
      request,
      env,
      params,
      variables,
      responseHolder,
      reverse,
    );

    // Track if next() was called and capture its Promise
    // This handles the case where middleware calls next() synchronously without await
    let nextPromise: Promise<Response> | null = null;
    const wrappedNext = (): Promise<Response> => {
      nextPromise = next();
      return nextPromise;
    };

    const result = await entry.handler(ctx, wrappedNext);

    // Explicit return takes precedence
    if (result instanceof Response) {
      responseHolder.response = result;
      return result;
    }

    // Warn about unexpected return values (non-Response, non-undefined)
    // This catches common mistakes like returning strings or objects
    if (result !== undefined) {
      const fnName = entry.handler.name || "(anonymous)";
      console.warn(
        `[Middleware] "${fnName}" returned ${typeof result} instead of Response or undefined. ` +
          `This return value will be ignored. Did you mean to return a Response?`,
      );
    }

    // If middleware called next(), await it and return the response
    if (nextPromise) {
      await nextPromise;
      return responseHolder.response!;
    }

    // Middleware didn't call next() and didn't return a Response - that's an error
    // (Note: responseHolder.response is the stub, but we require next() or explicit return)
    const fnName = entry.handler.name || "(anonymous)";
    throw new Error(
      `Middleware must call next() or return a Response. ` +
        `Function: ${fnName}, Pattern: ${entry.pattern ?? "(all)"}
        Source: ${import.meta.env.DEV ? entry.handler.toString().slice(0, 200) : "(source hidden in production)"}`,
      { cause: { url: request.url, fn: entry.handler } },
    );
  };

  await next();

  // Use the final response from responseHolder (may have been modified by middleware)
  const finalResponse = responseHolder.response;
  if (!finalResponse) {
    throw new Error("No response generated by middleware chain");
  }

  return finalResponse;
}

/**
 * Execute middleware for server actions
 *
 * Server actions can't return Response directly, but headers/cookies set
 * on ctx.res (from getRequestContext().res) will be merged into the final response.
 *
 * - Runs middleware for auth checks, variable setting, headers, cookies
 * - Throws if middleware returns Response (can't short-circuit server action)
 */
export async function executeServerActionMiddleware<TEnv>(
  middlewares: MiddlewareFn<TEnv>[],
  request: Request,
  env: TEnv,
  params: Record<string, string>,
  variables: Record<string, any>,
  stubResponse: Response,
  reverse?: (
    name: string,
    params?: Record<string, string>,
    search?: Record<string, unknown>,
  ) => string,
): Promise<void> {
  if (middlewares.length === 0) {
    return;
  }

  let index = 0;
  const responseHolder: ResponseHolder = { response: stubResponse };

  const next = async (): Promise<Response> => {
    if (index >= middlewares.length) {
      return stubResponse;
    }

    const middleware = middlewares[index++];
    const ctx = createMiddlewareContext(
      request,
      env,
      params,
      variables,
      responseHolder,
      reverse,
    );

    const result = await middleware(ctx, next);

    // If middleware returned a Response, throw an error
    // Server actions can't short-circuit with a Response
    if (result instanceof Response) {
      throw new Error(
        `Loader middleware returned a Response (status: ${result.status}). ` +
          `Server actions cannot return Response. ` +
          `Use GET-based loader fetching for redirects, or throw an error instead.`,
      );
    }

    return stubResponse;
  };

  await next();
  // Headers/cookies set on stubResponse will be merged by the caller
}

/**
 * Execute middleware for intercepts (simplified execution)
 *
 * Intercepts use a shared stubResponse from the request context. This function:
 * - Runs middleware in sequence with a simple next() chain
 * - Returns Response if any middleware short-circuits (returns Response or redirects BEFORE next())
 * - Returns null if all middleware calls next() - headers set after next() remain on stubResponse
 *
 * @param middlewares - Array of middleware functions
 * @param request - Original request
 * @param env - Environment bindings
 * @param params - Route params
 * @param variables - Shared variables object
 * @param stubResponse - Response from request context for collecting headers/cookies
 */
export async function executeInterceptMiddleware<TEnv>(
  middlewares: MiddlewareFn<TEnv>[],
  request: Request,
  env: TEnv,
  params: Record<string, string>,
  variables: Record<string, any>,
  stubResponse: Response,
  reverse?: (
    name: string,
    params?: Record<string, string>,
    search?: Record<string, unknown>,
  ) => string,
): Promise<Response | null> {
  if (middlewares.length === 0) {
    return null;
  }

  let index = 0;
  let earlyResponse: Response | null = null;

  // Use provided stubResponse - headers/cookies set here will be merged by the caller
  const responseHolder: ResponseHolder = { response: stubResponse };

  const next = async (): Promise<Response> => {
    if (index >= middlewares.length || earlyResponse) {
      return stubResponse;
    }

    const middleware = middlewares[index++];
    const ctx = createMiddlewareContext(
      request,
      env,
      params,
      variables,
      responseHolder,
      reverse,
    );

    const result = await middleware(ctx, next);

    if (result instanceof Response) {
      earlyResponse = result;
      return result;
    }

    // Check if middleware replaced ctx.res with a different response
    if (responseHolder.response && responseHolder.response !== stubResponse) {
      earlyResponse = responseHolder.response;
      return earlyResponse;
    }

    return stubResponse;
  };

  await next();

  // Return early response if middleware short-circuited (returned Response BEFORE next())
  if (earlyResponse) {
    // Capture in const for TypeScript narrowing (earlyResponse is `let` which loses narrowing in callbacks)
    const response: Response = earlyResponse;

    // Merge any headers/cookies set on stub into the early response
    let hasStubHeaders = false;
    stubResponse.headers.forEach(() => {
      hasStubHeaders = true;
    });

    if (hasStubHeaders) {
      // Clone and merge headers from stub into early response
      const mergedHeaders = new Headers(response.headers);
      stubResponse.headers.forEach((value, name) => {
        if (name.toLowerCase() === "set-cookie") {
          mergedHeaders.append(name, value);
        } else {
          mergedHeaders.set(name, value);
        }
      });
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: mergedHeaders,
      });
    }
    return response;
  }

  // All middleware completed without short-circuit
  // Headers/cookies set on stubResponse will be merged into the final response by the caller
  return null;
}

/**
 * Execute middleware chain for loaders (simpler signature)
 *
 * Takes an array of MiddlewareFn directly (no entry wrapper needed).
 * Used for fetchable loader middleware execution.
 */
export async function executeLoaderMiddleware<TEnv>(
  middlewares: MiddlewareFn<TEnv>[],
  request: Request,
  env: TEnv,
  params: Record<string, string>,
  variables: Record<string, any>,
  finalHandler: () => Promise<Response>,
  reverse?: (
    name: string,
    params?: Record<string, string>,
    search?: Record<string, unknown>,
  ) => string,
): Promise<Response> {
  if (middlewares.length === 0) {
    return finalHandler();
  }

  // Convert to the format executeMiddleware expects
  const middlewareEntries = middlewares.map((handler) => ({
    entry: {
      pattern: null,
      regex: null,
      paramNames: [],
      handler,
      mountPrefix: null,
    } as MiddlewareEntry<TEnv>,
    params,
  }));

  return executeMiddleware(
    middlewareEntries,
    request,
    env,
    variables,
    finalHandler,
    reverse,
  );
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

/**
 * Collect route-level middleware from an entry tree
 *
 * Recursively collects middleware from entries and their orphan layouts.
 * Used by match(), matchPartial(), and previewMatch() to gather route middleware.
 *
 * @param entries - Iterable of entries to collect middleware from (typically from traverseBack)
 * @param params - Route params to attach to each middleware entry
 * @returns Array of collected middleware with params
 */
export function collectRouteMiddleware(
  entries: Iterable<MiddlewareCollectableEntry>,
  params: Record<string, string>,
): CollectedMiddleware[] {
  const result: CollectedMiddleware[] = [];

  const collect = (entry: MiddlewareCollectableEntry): void => {
    // Collect entry's own middleware
    if (entry.middleware && entry.middleware.length > 0) {
      for (const mw of entry.middleware) {
        result.push({ handler: mw, params });
      }
    }
    // Collect middleware from orphan layouts (recursive)
    if (entry.layout && entry.layout.length > 0) {
      for (const orphan of entry.layout) {
        collect(orphan);
      }
    }
  };

  for (const entry of entries) {
    collect(entry);
  }

  return result;
}
