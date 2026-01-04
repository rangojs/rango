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
 * @template TEnv - Environment type (bindings, variables)
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
   * Response object (available after `await next()`)
   * Can be used to modify headers directly like Hono's `c.res`
   *
   * @example
   * ```typescript
   * middleware(async (ctx, next) => {
   *   await next();
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
    options?: Pick<CookieOptions, "domain" | "path">
  ): void;

  /** Get a context variable (shared with route handlers) */
  get<K extends string>(key: K): any;

  /** Set a context variable (shared with route handlers) */
  set<K extends string>(key: K, value: any): void;

  /**
   * Set a response header
   * Shorthand for `ctx.res.headers.set()`
   */
  header(name: string, value: string): void;
}

/**
 * Middleware function signature
 *
 * @template TEnv - Environment type
 * @template TParams - URL params type (typed for route middleware)
 */
export type MiddlewareFn<TEnv = any, TParams = Record<string, string>> = (
  ctx: MiddlewareContext<TEnv, TParams>,
  next: () => Promise<Response>
) => Response | Promise<Response> | void | Promise<void>;

/**
 * Stored middleware entry with pattern matching info
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
  paramNames: string[]
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
  cookieHeader: string | null
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
  options: CookieOptions = {}
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
 */
export function createMiddlewareContext<TEnv>(
  request: Request,
  env: TEnv,
  params: Record<string, string>,
  variables: Record<string, any>,
  pendingCookies: string[],
  responseHolder: ResponseHolder
): MiddlewareContext<TEnv> {
  const url = new URL(request.url);
  const cookieHeader = request.headers.get("Cookie");
  let parsedCookies: Record<string, string> | null = null;

  return {
    request,
    url,
    pathname: url.pathname,
    searchParams: url.searchParams,
    env,
    params,

    // res getter - returns the current response (available after next())
    get res(): Response {
      if (!responseHolder.response) {
        throw new Error(
          "ctx.res is not available until after await next() is called"
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
      pendingCookies.push(serializeCookie(name, value, options));
    },

    deleteCookie(
      name: string,
      options?: Pick<CookieOptions, "domain" | "path">
    ): void {
      pendingCookies.push(serializeCookie(name, "", { ...options, maxAge: 0 }));
    },

    get<K extends string>(key: K): any {
      return variables[key];
    },

    set<K extends string>(key: K, value: any): void {
      variables[key] = value;
    },

    header(name: string, value: string): void {
      if (!responseHolder.response) {
        throw new Error(
          "ctx.header() is not available until after await next() is called"
        );
      }
      responseHolder.response.headers.set(name, value);
    },
  };
}

/**
 * Match middleware entries against a pathname
 * Returns entries that match, with extracted params
 */
export function matchMiddleware<TEnv>(
  pathname: string,
  entries: MiddlewareEntry<TEnv>[]
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
 * Apply pending cookies to a response
 * Returns new Response with Set-Cookie headers added
 */
export function applyPendingCookies(
  response: Response,
  pendingCookies: string[]
): Response {
  if (pendingCookies.length === 0) {
    return response;
  }

  // Clone response to make headers mutable
  const newResponse = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });

  for (const cookie of pendingCookies) {
    newResponse.headers.append("Set-Cookie", cookie);
  }

  return newResponse;
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
  finalHandler: () => Promise<Response>
): Promise<Response> {
  const pendingCookies: string[] = [];
  let index = 0;

  // Shared response holder - allows ctx.res to work across middleware
  const responseHolder: ResponseHolder = { response: null };

  const next = async (): Promise<Response> => {
    if (index >= middlewares.length) {
      // End of chain - call actual RSC handler
      const response = await finalHandler();
      // Clone response to make headers mutable for middleware
      responseHolder.response = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers),
      });
      return responseHolder.response;
    }

    const { entry, params } = middlewares[index++];
    const ctx = createMiddlewareContext(
      request,
      env,
      params,
      variables,
      pendingCookies,
      responseHolder
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

    // If middleware called next() but didn't await it, wait for it now
    if (nextPromise) {
      await nextPromise;
    }

    // Forgiving: middleware didn't return, use ctx.res (responseHolder)
    if (responseHolder.response) {
      return responseHolder.response;
    }

    // Middleware didn't call next() and didn't return - that's an error
    const fnName = entry.handler.name || "(anonymous)";
    throw new Error(
      `Middleware must call next() or return a Response. ` +
        `Function: ${fnName}, Pattern: ${entry.pattern ?? "(all)"}
        Source: ${import.meta.env.DEV ? entry.handler.toString().slice(0, 200) : "(source hidden in production)"}`,
      { cause: { url: request.url, fn: entry.handler } }
    );
  };

  await next();

  // Use the final response from responseHolder (may have been modified by middleware)
  const finalResponse = responseHolder.response;
  if (!finalResponse) {
    throw new Error("No response generated by middleware chain");
  }

  // Apply any cookies that were set during middleware execution
  return applyPendingCookies(finalResponse, pendingCookies);
}

/**
 * Execute middleware for server actions (no Response available)
 *
 * Server actions can't return Response, so this function:
 * - Runs middleware for auth checks, variable setting, etc.
 * - Throws if middleware returns Response (can't return from server action)
 * - Provides limited ctx (no ctx.res access)
 */
export async function executeServerActionMiddleware<TEnv>(
  middlewares: MiddlewareFn<TEnv>[],
  request: Request,
  env: TEnv,
  params: Record<string, string>,
  variables: Record<string, any>
): Promise<void> {
  if (middlewares.length === 0) {
    return;
  }

  const pendingCookies: string[] = [];
  let index = 0;

  // No response holder - server actions can't return Response
  const responseHolder: ResponseHolder = { response: null };

  const next = async (): Promise<Response> => {
    if (index >= middlewares.length) {
      // End of middleware chain - return a dummy response
      // This response is never actually used, just needed for the type
      responseHolder.response = new Response(null, { status: 200 });
      return responseHolder.response;
    }

    const middleware = middlewares[index++];
    const ctx = createMiddlewareContext(
      request,
      env,
      params,
      variables,
      pendingCookies,
      responseHolder
    );

    const result = await middleware(ctx, next);

    // If middleware returned a Response, throw an error
    // Server actions can't return Response
    if (result instanceof Response) {
      throw new Error(
        `Loader middleware returned a Response (status: ${result.status}). ` +
          `Server actions cannot return Response. ` +
          `Use GET-based loader fetching for redirects, or throw an error instead.`
      );
    }

    // Return dummy response for type compatibility
    return responseHolder.response || new Response(null, { status: 200 });
  };

  await next();
}

/**
 * Execute middleware for intercepts (simplified execution)
 *
 * Intercepts don't need full response wrapping. This function:
 * - Runs middleware in sequence with a simple next() chain
 * - Returns Response if any middleware short-circuits
 * - Returns null if all middleware calls next() without returning Response
 *
 * @param middlewares - Array of middleware functions
 * @param request - Original request
 * @param env - Environment bindings
 * @param params - Route params
 * @param variables - Shared variables object
 */
export async function executeInterceptMiddleware<TEnv>(
  middlewares: MiddlewareFn<TEnv>[],
  request: Request,
  env: TEnv,
  params: Record<string, string>,
  variables: Record<string, any>
): Promise<Response | null> {
  if (middlewares.length === 0) {
    return null;
  }

  const pendingCookies: string[] = [];
  let index = 0;
  let earlyResponse: Response | null = null;

  // Dummy response holder - intercepts don't have a real response until handler runs
  const responseHolder: ResponseHolder = { response: null };

  const next = async (): Promise<Response> => {
    if (index >= middlewares.length || earlyResponse) {
      // Return a dummy response - intercept middleware shouldn't need ctx.res
      return new Response(null, { status: 200 });
    }

    const middleware = middlewares[index++];
    const ctx = createMiddlewareContext(
      request,
      env,
      params,
      variables,
      pendingCookies,
      responseHolder
    );

    const result = await middleware(ctx, next);

    if (result instanceof Response) {
      earlyResponse = result;
      return result;
    }

    return new Response(null, { status: 200 });
  };

  await next();
  return earlyResponse;
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
  finalHandler: () => Promise<Response>
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
    finalHandler
  );
}
