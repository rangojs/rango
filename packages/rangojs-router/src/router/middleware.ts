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

import { contextGet, contextSet } from "../context-var.js";
import type {
  CookieOptions,
  CollectedMiddleware,
  MiddlewareCollectableEntry,
  MiddlewareContext,
  MiddlewareEntry,
  MiddlewareFn,
  ResponseHolder,
} from "./middleware-types.js";
import { parseCookies, serializeCookie } from "./middleware-cookies.js";

// Re-export types and cookie utilities for backward compatibility
export type {
  CookieOptions,
  CollectedMiddleware,
  MiddlewareCollectableEntry,
  MiddlewareContext,
  MiddlewareEntry,
  MiddlewareFn,
  ResponseHolder,
} from "./middleware-types.js";
export { parseCookies, serializeCookie } from "./middleware-cookies.js";

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
 * Create middleware context
 *
 * Note: The implementation uses runtime values while the interface provides
 * compile-time type safety. The env/get/set types are resolved at call sites
 * via conditional types based on TEnv from createRouter<TBindings>().
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

    // Explicit return takes precedence (middleware short-circuit).
    // Merge stub headers (from ctx.header/setCookie before this point)
    // into the returned Response so they are not lost.
    if (result instanceof Response) {
      const mergedHeaders = new Headers(result.headers);
      stubResponse.headers.forEach((value, name) => {
        if (name.toLowerCase() === "set-cookie") {
          mergedHeaders.append(name, value);
        } else if (!mergedHeaders.has(name)) {
          mergedHeaders.set(name, value);
        }
      });
      const merged = new Response(result.body, {
        status: result.status,
        statusText: result.statusText,
        headers: mergedHeaders,
      });
      responseHolder.response = merged;
      return merged;
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
