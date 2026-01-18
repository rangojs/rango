/**
 * Request Context - AsyncLocalStorage for passing request-scoped data throughout rendering
 *
 * This is the unified context used everywhere:
 * - Middleware execution
 * - Route handlers and loaders
 * - Server components during rendering
 * - Error boundaries and streaming
 *
 * Available via getRequestContext() anywhere in the request lifecycle.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { CookieOptions } from "../router/middleware.js";
import type { LoaderDefinition, LoaderContext } from "../types.js";
import type { Handle } from "../handle.js";
import { createHandleStore, type HandleStore } from "./handle-store.js";
import { isHandle } from "../handle.js";
import { track } from "./context.js";

/**
 * Unified request context available via getRequestContext()
 *
 * This is the same context passed to middleware and handlers.
 * Use this when you need access to request data outside of route handlers.
 */
export interface RequestContext<
  TEnv = unknown,
  TParams = Record<string, string>,
> {
  /** Platform bindings (Cloudflare env, etc.) */
  env: TEnv;
  /** Original HTTP request */
  request: Request;
  /** Parsed URL (system params like _rsc* are NOT filtered here) */
  url: URL;
  /** URL pathname */
  pathname: string;
  /** URL search params (system params like _rsc* are NOT filtered here) */
  searchParams: URLSearchParams;
  /** Variables set by middleware (same as ctx.var) */
  var: Record<string, any>;
  /** Get a variable set by middleware */
  get: <K extends string>(key: K) => any;
  /** Set a variable (shared with middleware and handlers) */
  set: <K extends string>(key: K, value: any) => void;
  /**
   * Route params (populated after route matching)
   * Initially empty, then set to matched params
   */
  params: TParams;
  /**
   * Stub response for setting headers/cookies
   * Headers set here are merged into the final response
   */
  res: Response;

  /** Get a cookie value from the request */
  cookie(name: string): string | undefined;
  /** Get all cookies from the request */
  cookies(): Record<string, string>;
  /** Set a cookie on the response */
  setCookie(name: string, value: string, options?: CookieOptions): void;
  /** Delete a cookie */
  deleteCookie(name: string, options?: Pick<CookieOptions, "domain" | "path">): void;
  /** Set a response header */
  header(name: string, value: string): void;

  /**
   * Access loader data or push handle data.
   *
   * For loaders: Returns a promise that resolves to the loader data.
   * Loaders are executed in parallel and memoized per request.
   *
   * For handles: Returns a push function to add data for this segment.
   * Handle data accumulates across all matched route segments.
   *
   * @example
   * ```typescript
   * // Loader usage
   * const cart = await ctx.use(CartLoader);
   *
   * // Handle usage
   * const push = ctx.use(Breadcrumbs);
   * push({ label: "Shop", href: "/shop" });
   * ```
   */
  use: {
    <T, TLoaderParams = any>(loader: LoaderDefinition<T, TLoaderParams>): Promise<T>;
    <TData, TAccumulated = TData[]>(handle: Handle<TData, TAccumulated>): (
      data: TData | Promise<TData> | (() => Promise<TData>)
    ) => void;
  };

  /** HTTP method (GET, POST, PUT, PATCH, DELETE, etc.) */
  method: string;

  /** @internal Handle store for tracking handle data across segments */
  _handleStore: HandleStore;
}

// AsyncLocalStorage instance for request context
const requestContextStorage = new AsyncLocalStorage<RequestContext<any>>();

/**
 * Run a function within a request context
 * Used by the RSC handler to provide context to server actions
 */
export function runWithRequestContext<TEnv, T>(
  context: RequestContext<TEnv>,
  fn: () => T
): T {
  return requestContextStorage.run(context, fn);
}

/**
 * Get the current request context
 * Returns undefined if not running within a request context
 */
export function getRequestContext<TEnv = unknown>():
  | RequestContext<TEnv>
  | undefined {
  return requestContextStorage.getStore() as RequestContext<TEnv> | undefined;
}

/**
 * Update params on the current request context
 * Called after route matching to populate route params
 */
export function setRequestContextParams(params: Record<string, string>): void {
  const ctx = requestContextStorage.getStore();
  if (ctx) {
    ctx.params = params;
  }
}

/**
 * Get the current request context, throwing if not available
 * Use this when context is required (e.g., in loader actions)
 */
export function requireRequestContext<TEnv = unknown>(): RequestContext<TEnv> {
  const ctx = getRequestContext<TEnv>();
  if (!ctx) {
    throw new Error(
      "Request context not available. This function must be called from within a server action " +
        "executed through the RSC handler."
    );
  }
  return ctx;
}

/**
 * Options for creating a request context
 */
export interface CreateRequestContextOptions<TEnv> {
  env: TEnv;
  request: Request;
  url: URL;
  variables: Record<string, any>;
}

/**
 * Create a full request context with all methods implemented
 *
 * This is used by the RSC handler to create the unified context that's:
 * - Available via getRequestContext() throughout the request
 * - Passed to middleware as ctx
 * - Passed to handlers as ctx
 */
export function createRequestContext<TEnv>(
  options: CreateRequestContextOptions<TEnv>
): RequestContext<TEnv> {
  const { env, request, url, variables } = options;
  const cookieHeader = request.headers.get("Cookie");
  let parsedCookies: Record<string, string> | null = null;

  // Create stub response for collecting headers/cookies
  const stubResponse = new Response(null, { status: 200 });

  // Create handle store and loader memoization for this request
  const handleStore = createHandleStore();
  const loaderPromises = new Map<string, Promise<any>>();

  // Lazy parse cookies
  const getParsedCookies = (): Record<string, string> => {
    if (!parsedCookies) {
      parsedCookies = parseCookiesFromHeader(cookieHeader);
    }
    return parsedCookies;
  };

  // Build the context object first (without use), then add use
  const ctx: RequestContext<TEnv> = {
    env,
    request,
    url,
    pathname: url.pathname,
    searchParams: url.searchParams,
    var: variables,
    get: <K extends string>(key: K) => variables[key],
    set: <K extends string>(key: K, value: any) => {
      variables[key] = value;
    },
    params: {} as Record<string, string>,
    res: stubResponse,

    cookie(name: string): string | undefined {
      return getParsedCookies()[name];
    },

    cookies(): Record<string, string> {
      return { ...getParsedCookies() };
    },

    setCookie(name: string, value: string, options?: CookieOptions): void {
      stubResponse.headers.append(
        "Set-Cookie",
        serializeCookieValue(name, value, options)
      );
    },

    deleteCookie(
      name: string,
      options?: Pick<CookieOptions, "domain" | "path">
    ): void {
      stubResponse.headers.append(
        "Set-Cookie",
        serializeCookieValue(name, "", { ...options, maxAge: 0 })
      );
    },

    header(name: string, value: string): void {
      stubResponse.headers.set(name, value);
    },

    // Placeholder - will be replaced below
    use: null as any,

    method: request.method,

    _handleStore: handleStore,
  };

  // Now create use() with access to ctx
  ctx.use = createUseFunction({
    handleStore,
    loaderPromises,
    getContext: () => ctx,
  });

  return ctx;
}

/**
 * Parse cookies from Cookie header
 */
function parseCookiesFromHeader(
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
function serializeCookieValue(
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
 * Options for creating the use() function
 */
export interface CreateUseFunctionOptions<TEnv> {
  handleStore: HandleStore;
  loaderPromises: Map<string, Promise<any>>;
  getContext: () => RequestContext<TEnv>;
}

/**
 * Create the use() function for loader and handle composition.
 *
 * This is the unified implementation used by both RequestContext and HandlerContext.
 * - For loaders: executes and memoizes loader functions
 * - For handles: returns a push function to add handle data
 */
export function createUseFunction<TEnv>(
  options: CreateUseFunctionOptions<TEnv>
): RequestContext["use"] {
  const { handleStore, loaderPromises, getContext } = options;

  return ((item: LoaderDefinition<any, any> | Handle<any, any>) => {
    // Handle case: return a push function
    if (isHandle(item)) {
      const handle = item;
      const ctx = getContext();
      const segmentId = (ctx as any)._currentSegmentId;

      if (!segmentId) {
        throw new Error(
          `Handle "${handle.$$id}" used outside of handler context. ` +
            `Handles must be used within route/layout handlers.`
        );
      }

      // Return a push function bound to this handle and segment
      return (dataOrFn: unknown | Promise<unknown> | (() => Promise<unknown>)) => {
        // If it's a function, call it immediately to get the promise
        const valueOrPromise = typeof dataOrFn === "function"
          ? (dataOrFn as () => Promise<unknown>)()
          : dataOrFn;

        // Push directly - promises will be serialized by RSC and streamed
        handleStore.push(handle.$$id, segmentId, valueOrPromise);
      };
    }

    // Loader case
    const loader = item as LoaderDefinition<any, any>;

    // Return cached promise if already started
    if (loaderPromises.has(loader.$$id)) {
      return loaderPromises.get(loader.$$id);
    }

    // Get loader function - either from loader object or fetchable registry
    let loaderFn = loader.fn;
    if (!loaderFn) {
      // Lazy import to avoid circular dependency
      const { getFetchableLoader } = require("../loader.rsc.js");
      const fetchable = getFetchableLoader(loader.$$id);
      if (fetchable) {
        loaderFn = fetchable.fn;
      }
    }

    if (!loaderFn) {
      throw new Error(
        `Loader "${loader.$$id}" has no function. This usually means the loader was defined without "use server" and the function was not included in the build.`
      );
    }

    const ctx = getContext();

    // Create loader context with recursive use() support
    const loaderCtx: LoaderContext<Record<string, string | undefined>, TEnv> = {
      params: ctx.params,
      request: ctx.request,
      searchParams: ctx.searchParams,
      pathname: ctx.pathname,
      url: ctx.url,
      env: ctx.env as any,
      var: ctx.var as any,
      get: ctx.get as any,
      use: <TDep, TDepParams = any>(
        dep: LoaderDefinition<TDep, TDepParams>
      ): Promise<TDep> => {
        // Recursive call - will start dep loader if not already started
        return ctx.use(dep);
      },
      method: "GET",
      body: undefined,
    };

    // Start loader execution with tracking
    const doneLoader = track(`loader:${loader.$$id}`);
    const promise = Promise.resolve(loaderFn(loaderCtx)).finally(() => {
      doneLoader();
    });

    // Memoize for subsequent calls
    loaderPromises.set(loader.$$id, promise);

    return promise;
  }) as RequestContext["use"];
}
