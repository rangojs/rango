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
  CollectedMiddleware,
  MiddlewareCollectableEntry,
  MiddlewareContext,
  MiddlewareEntry,
  MiddlewareFn,
  ResponseHolder,
} from "./middleware-types.js";
import { _getRequestContext } from "../server/request-context.js";

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

// W5: Deduplicate by function reference so each distinct middleware warns once,
// regardless of whether it is named or anonymous.
let warnedRedirectMiddleware = new WeakSet<Function>();

function warnCtxSetBeforeRedirect(handler: Function): void {
  if (warnedRedirectMiddleware.has(handler)) return;
  warnedRedirectMiddleware.add(handler);
  const label = handler.name || "(anonymous)";
  console.warn(
    `[rango] Route middleware "${label}" called ctx.set() then returned a ` +
      `redirect. Context variables are per-request and won't be available ` +
      `on the redirect target. Use cookies to persist state across ` +
      `redirects, or move ctx.set() to the target route's middleware.`,
  );
}

/** Reset W5 deduplication state (for tests only). */
export function _resetW5Warnings(): void {
  warnedRedirectMiddleware = new WeakSet();
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

  // Track the initial response to detect pre/post-next() phase.
  // Before next(): responseHolder.response === initialResponse (the stub).
  // After next(): responseHolder.response is the real downstream response.
  const initialResponse = responseHolder.response;
  const isPreNext = () => responseHolder.response === initialResponse;

  // Delegation strategy for RequestContext (reqCtx):
  // - res getter: before next() returns shared reqCtx stub; after next() returns
  //   the real downstream response.
  // - header(): before next() delegates to reqCtx; after next() writes to the
  //   real downstream response.
  // Cookie operations are handled by the standalone cookies() function which
  // delegates to the shared RequestContext internally.
  // The runtime implementation - types are enforced at call sites via MiddlewareContext<TEnv>
  return {
    request,
    url,
    pathname: url.pathname,
    searchParams: url.searchParams,
    env: env as MiddlewareContext<TEnv>["env"],
    params,

    get res(): Response {
      // Before next(): return shared RequestContext stub so headers
      // set via ctx.header() are visible on ctx.res.
      if (isPreNext()) {
        const reqCtx = _getRequestContext();
        if (reqCtx) return reqCtx.res;
      }
      if (!responseHolder.response) {
        throw new Error(
          "ctx.res is not available - responseHolder was not initialized",
        );
      }
      return responseHolder.response;
    },
    set res(_: Response) {
      throw new Error(
        "ctx.res is read-only. Use ctx.header() to set response headers, or cookies() for cookie mutations.",
      );
    },

    get: ((keyOrVar: any) =>
      contextGet(variables, keyOrVar)) as MiddlewareContext<TEnv>["get"],

    set: ((keyOrVar: any, value: unknown) => {
      contextSet(variables, keyOrVar, value);
    }) as MiddlewareContext<TEnv>["set"],

    header(name: string, value: string): void {
      // Before next(): delegate to shared RequestContext stub
      if (isPreNext()) {
        const reqCtx = _getRequestContext();
        if (reqCtx) {
          reqCtx.header(name, value);
          return;
        }
      }
      // After next() or standalone: write to current response
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

      // Merge headers set on stub into the real response.
      // Use append for Set-Cookie to preserve multiple cookies.
      const mergedHeaders = new Headers(response.headers);
      stubResponse.headers.forEach((value, name) => {
        if (name.toLowerCase() === "set-cookie") {
          mergedHeaders.append(name, value);
        } else {
          mergedHeaders.set(name, value);
        }
      });
      // Also merge shared RequestContext stub (cookies written via cookies().set()).
      // Set-Cookie duplication is prevented by createResponseWithMergedHeaders
      // draining Set-Cookie from ctx.res after merging (helpers.ts).
      const reqCtx = _getRequestContext();
      if (reqCtx) {
        reqCtx.res.headers.forEach((value, name) => {
          if (name.toLowerCase() === "set-cookie") {
            mergedHeaders.append(name, value);
          } else if (!mergedHeaders.has(name)) {
            mergedHeaders.set(name, value);
          }
        });
      }

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

    // Track if next() was called and capture its Promise.
    // Guard against double-calling: a second call would re-enter the
    // downstream chain and overwrite responseHolder.response.
    let nextPromise: Promise<Response> | null = null;
    const wrappedNext = (): Promise<Response> => {
      if (nextPromise) {
        throw new Error(
          `[@rangojs/router] Middleware called next() more than once.`,
        );
      }
      nextPromise = next();
      return nextPromise;
    };

    // W5: track whether ctx.set() is called during this middleware
    let ctxSetCalled = false;
    if (process.env.NODE_ENV !== "production") {
      const originalSet = ctx.set;
      ctx.set = ((...args: any[]) => {
        ctxSetCalled = true;
        return (originalSet as Function).apply(ctx, args);
      }) as typeof ctx.set;
    }

    const result = await entry.handler(ctx, wrappedNext);

    // Explicit return takes precedence (middleware short-circuit).
    // Merge stub headers (from ctx.header before this point) and
    // RequestContext stub headers (from ctx.setCookie) into the
    // returned Response so they are not lost.
    if (result instanceof Response) {
      // W5: warn if ctx.set() was called but middleware returned a redirect
      if (
        process.env.NODE_ENV !== "production" &&
        ctxSetCalled &&
        result.status >= 300 &&
        result.status < 400
      ) {
        warnCtxSetBeforeRedirect(entry.handler);
      }

      const mergedHeaders = new Headers(result.headers);
      stubResponse.headers.forEach((value, name) => {
        if (name.toLowerCase() === "set-cookie") {
          mergedHeaders.append(name, value);
        } else if (!mergedHeaders.has(name)) {
          mergedHeaders.set(name, value);
        }
      });
      // Also merge shared RequestContext stub (cookies written via setCookie)
      const reqCtx = _getRequestContext();
      if (reqCtx) {
        reqCtx.res.headers.forEach((value, name) => {
          if (name.toLowerCase() === "set-cookie") {
            mergedHeaders.append(name, value);
          } else if (!mergedHeaders.has(name)) {
            mergedHeaders.set(name, value);
          }
        });
      }
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

      // W5: warn if ctx.set() was called but the downstream response is a redirect.
      // The ctx.set() values will be lost because the redirect navigates away.
      if (
        process.env.NODE_ENV !== "production" &&
        ctxSetCalled &&
        responseHolder.response &&
        responseHolder.response.status >= 300 &&
        responseHolder.response.status < 400
      ) {
        warnCtxSetBeforeRedirect(entry.handler);
      }

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

    let nextCalled = false;
    const guardedNext = (): Promise<Response> => {
      if (nextCalled) {
        throw new Error(
          `[@rangojs/router] Intercept middleware called next() more than once.`,
        );
      }
      nextCalled = true;
      return next();
    };

    const result = await middleware(ctx, guardedNext);

    if (result instanceof Response) {
      earlyResponse = result;
      return result;
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
      // Clone and merge headers from stub into early response.
      // Only fill in missing headers — the returned Response's explicit
      // headers take precedence, matching executeMiddleware behavior.
      const mergedHeaders = new Headers(response.headers);
      stubResponse.headers.forEach((value, name) => {
        if (name.toLowerCase() === "set-cookie") {
          mergedHeaders.append(name, value);
        } else if (!mergedHeaders.has(name)) {
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
