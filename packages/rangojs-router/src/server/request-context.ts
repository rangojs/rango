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
import { type ContextVar, contextGet, contextSet } from "../context-var.js";
import { createHandleStore, type HandleStore } from "./handle-store.js";
import { isHandle } from "../handle.js";
import { track } from "./context.js";
import { getFetchableLoader } from "./fetchable-loader-store.js";
import type { SegmentCacheStore } from "../cache/types.js";
import type { Theme, ResolvedThemeConfig } from "../theme/types.js";
import { THEME_COOKIE } from "../theme/constants.js";
import type { LocationStateEntry } from "../browser/react/location-state-shared.js";
import { NOCACHE_SYMBOL, assertNotInsideCacheExec } from "../cache/taint.js";
import { createReverseFunction } from "../router/handler-context.js";
import { getGlobalRouteMap } from "../route-map-builder.js";

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
  get: {
    <T>(contextVar: ContextVar<T>): T | undefined;
    <K extends string>(key: K): any;
  };
  /** Set a variable (shared with middleware and handlers) */
  set: {
    <T>(contextVar: ContextVar<T>, value: T): void;
    <K extends string>(key: K, value: any): void;
  };
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
  deleteCookie(
    name: string,
    options?: Pick<CookieOptions, "domain" | "path">,
  ): void;
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
    <T, TLoaderParams = any>(
      loader: LoaderDefinition<T, TLoaderParams>,
    ): Promise<T>;
    <TData, TAccumulated = TData[]>(
      handle: Handle<TData, TAccumulated>,
    ): (data: TData | Promise<TData> | (() => Promise<TData>)) => void;
  };

  /** HTTP method (GET, POST, PUT, PATCH, DELETE, etc.) */
  method: string;

  /**
   * @internal Replay Set-Cookie response headers into the parsed cookie cache.
   * Used by inline action redirects so that ctx.cookie() on the redirect target
   * sees cookies set during the action.
   */
  _replayCookiesFromResponse(): void;

  /** @internal Handle store for tracking handle data across segments */
  _handleStore: HandleStore;

  /** @internal Cache store for segment caching (optional, used by CacheScope) */
  _cacheStore?: SegmentCacheStore;

  /**
   * Schedule work to run after the response is sent.
   * On Cloudflare Workers, uses ctx.waitUntil().
   * On Node.js, runs as fire-and-forget.
   *
   * @example
   * ```typescript
   * ctx.waitUntil(async () => {
   *   await cacheStore.set(key, data, ttl);
   * });
   * ```
   */
  waitUntil(fn: () => Promise<void>): void;

  /**
   * Register a callback to run when the response is created.
   * Callbacks are sync and receive the response. They can:
   * - Inspect response status/headers
   * - Return a modified response
   * - Schedule async work via waitUntil
   *
   * @example
   * ```typescript
   * ctx.onResponse((res) => {
   *   if (res.status === 200) {
   *     ctx.waitUntil(async () => await cacheIt());
   *   }
   *   return res;
   * });
   * ```
   */
  onResponse(callback: (response: Response) => Response): void;

  /** @internal Registered onResponse callbacks */
  _onResponseCallbacks: Array<(response: Response) => Response>;

  /**
   * Current theme setting (only available when theme is enabled in router config)
   *
   * Returns the theme value from the cookie, or the default theme if not set.
   * This is the user's preference ("light", "dark", or "system"), not the resolved value.
   *
   * @example
   * ```typescript
   * route("settings", (ctx) => {
   *   const currentTheme = ctx.theme; // "light" | "dark" | "system" | undefined
   *   return <SettingsPage theme={currentTheme} />;
   * });
   * ```
   */
  theme?: Theme;

  /**
   * Set the theme (only available when theme is enabled in router config)
   *
   * Sets a cookie with the new theme value. The change takes effect on the next request.
   *
   * @example
   * ```typescript
   * route("settings", (ctx) => {
   *   if (ctx.method === "POST") {
   *     const formData = await ctx.request.formData();
   *     const newTheme = formData.get("theme") as Theme;
   *     ctx.setTheme(newTheme);
   *   }
   *   return <SettingsPage />;
   * });
   * ```
   */
  setTheme?: (theme: Theme) => void;

  /** @internal Theme configuration (null if theme not enabled) */
  _themeConfig?: ResolvedThemeConfig | null;

  /**
   * Attach location state entries to the current response.
   *
   * For partial (SPA) requests, the state is included in the RSC payload
   * metadata and merged into history.pushState on the client. For redirect
   * responses, the state travels through the redirect payload so the target
   * page can read it via useLocationState.
   *
   * Multiple calls accumulate entries.
   *
   * @example
   * ```typescript
   * ctx.setLocationState([Flash({ text: "Item saved!" })]);
   * ```
   */
  setLocationState(entries: LocationStateEntry[]): void;

  /** @internal Accumulated location state entries */
  _locationState?: LocationStateEntry[];

  /** @internal Route name from route matching, used for scoped reverse resolution */
  _routeName?: string;
}

// AsyncLocalStorage instance for request context
const requestContextStorage = new AsyncLocalStorage<RequestContext<any>>();

/**
 * Run a function within a request context
 * Used by the RSC handler to provide context to server actions
 */
export function runWithRequestContext<TEnv, T>(
  context: RequestContext<TEnv>,
  fn: () => T,
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
 * Called after route matching to populate route params and route name
 */
export function setRequestContextParams(
  params: Record<string, string>,
  routeName?: string,
): void {
  const ctx = requestContextStorage.getStore();
  if (ctx) {
    ctx.params = params;
    if (routeName !== undefined) {
      ctx._routeName = routeName;
    }
  }
}

/**
 * Get accumulated location state entries from the current request context.
 * Returns undefined if no state has been set.
 *
 * @internal Used by the RSC handler to include state in payload metadata.
 */
export function getLocationState(): LocationStateEntry[] | undefined {
  const ctx = getRequestContext();
  return ctx?._locationState;
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
        "executed through the RSC handler.",
    );
  }
  return ctx;
}

/**
 * Cloudflare Workers ExecutionContext (subset we need)
 */
export interface ExecutionContext {
  waitUntil(promise: Promise<any>): void;
  passThroughOnException(): void;
}

/**
 * Options for creating a request context
 */
export interface CreateRequestContextOptions<TEnv> {
  env: TEnv;
  request: Request;
  url: URL;
  variables: Record<string, any>;
  /** Optional cache store for segment caching (used by CacheScope) */
  cacheStore?: SegmentCacheStore;
  /** Optional Cloudflare execution context for waitUntil support */
  executionContext?: ExecutionContext;
  /** Optional theme configuration (enables ctx.theme and ctx.setTheme) */
  themeConfig?: ResolvedThemeConfig | null;
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
  options: CreateRequestContextOptions<TEnv>,
): RequestContext<TEnv> {
  const {
    env,
    request,
    url,
    variables,
    cacheStore,
    executionContext,
    themeConfig,
  } = options;
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

  // Theme helpers (only used when themeConfig is provided)
  const getTheme = (): Theme | undefined => {
    if (!themeConfig) return undefined;

    const stored = getParsedCookies()[themeConfig.storageKey];
    if (stored) {
      // Validate stored value
      if (stored === "system" && themeConfig.enableSystem) {
        return "system";
      }
      if (themeConfig.themes.includes(stored)) {
        return stored as Theme;
      }
    }
    return themeConfig.defaultTheme;
  };

  const setTheme = (theme: Theme): void => {
    if (!themeConfig) return;

    // Validate theme value
    if (theme !== "system" && !themeConfig.themes.includes(theme)) {
      console.warn(
        `[Theme] Invalid theme value: "${theme}". Valid values: system, ${themeConfig.themes.join(", ")}`,
      );
      return;
    }

    // Set cookie
    stubResponse.headers.append(
      "Set-Cookie",
      serializeCookieValue(themeConfig.storageKey, theme, {
        path: THEME_COOKIE.path,
        maxAge: THEME_COOKIE.maxAge,
        sameSite: THEME_COOKIE.sameSite,
      }),
    );
  };

  // Build the context object first (without use), then add use
  const ctx: RequestContext<TEnv> = {
    env,
    request,
    url,
    pathname: url.pathname,
    searchParams: url.searchParams,
    var: variables,
    get: ((keyOrVar: any) =>
      contextGet(variables, keyOrVar)) as RequestContext<TEnv>["get"],
    set: ((keyOrVar: any, value: any) => {
      assertNotInsideCacheExec(ctx, "set");
      contextSet(variables, keyOrVar, value);
    }) as RequestContext<TEnv>["set"],
    params: {} as Record<string, string>,
    res: stubResponse,

    cookie(name: string): string | undefined {
      return getParsedCookies()[name];
    },

    cookies(): Record<string, string> {
      return { ...getParsedCookies() };
    },

    setCookie(name: string, value: string, options?: CookieOptions): void {
      assertNotInsideCacheExec(ctx, "setCookie");
      stubResponse.headers.append(
        "Set-Cookie",
        serializeCookieValue(name, value, options),
      );
    },

    deleteCookie(
      name: string,
      options?: Pick<CookieOptions, "domain" | "path">,
    ): void {
      assertNotInsideCacheExec(ctx, "deleteCookie");
      stubResponse.headers.append(
        "Set-Cookie",
        serializeCookieValue(name, "", { ...options, maxAge: 0 }),
      );
    },

    header(name: string, value: string): void {
      assertNotInsideCacheExec(ctx, "header");
      stubResponse.headers.set(name, value);
    },

    _replayCookiesFromResponse(): void {
      const cookies = getParsedCookies();
      for (const header of stubResponse.headers.getSetCookie()) {
        const parts = header.split(";");
        const nameValue = parts[0]?.trim();
        if (!nameValue) continue;
        const eqIndex = nameValue.indexOf("=");
        if (eqIndex === -1) continue;
        const name = decodeURIComponent(nameValue.slice(0, eqIndex).trim());
        const value = decodeURIComponent(nameValue.slice(eqIndex + 1).trim());
        const isDelete = parts
          .slice(1)
          .some((p) => p.trim().toLowerCase() === "max-age=0");
        if (isDelete) {
          delete cookies[name];
        } else {
          cookies[name] = value;
        }
      }
    },

    // Placeholder - will be replaced below
    use: null as any,

    method: request.method,

    _handleStore: handleStore,
    _cacheStore: cacheStore,

    waitUntil(fn: () => Promise<void>): void {
      if (executionContext?.waitUntil) {
        // Cloudflare Workers: use native waitUntil
        executionContext.waitUntil(fn());
      } else {
        // Node.js / dev: fire-and-forget with error logging
        fn().catch((err) =>
          console.error("[waitUntil] Background task failed:", err),
        );
      }
    },

    _onResponseCallbacks: [],

    onResponse(callback: (response: Response) => Response): void {
      assertNotInsideCacheExec(ctx, "onResponse");
      this._onResponseCallbacks.push(callback);
    },

    // Theme properties (only set when themeConfig is provided)
    theme: themeConfig ? getTheme() : undefined,
    setTheme: themeConfig
      ? (theme: Theme) => {
          assertNotInsideCacheExec(ctx, "setTheme");
          setTheme(theme);
        }
      : undefined,
    _themeConfig: themeConfig,

    setLocationState(entries: LocationStateEntry[]): void {
      assertNotInsideCacheExec(ctx, "setLocationState");
      this._locationState = this._locationState
        ? [...this._locationState, ...entries]
        : entries;
    },
    _locationState: undefined,
  };

  // Now create use() with access to ctx
  ctx.use = createUseFunction({
    handleStore,
    loaderPromises,
    getContext: () => ctx,
  });

  // Brand with taint symbol so "use cache" excludes ctx from cache keys
  (ctx as any)[NOCACHE_SYMBOL] = true;
  return ctx;
}

/**
 * Parse cookies from Cookie header
 */
function parseCookiesFromHeader(
  cookieHeader: string | null,
): Record<string, string> {
  if (!cookieHeader) return {};

  const cookies: Record<string, string> = {};
  const pairs = cookieHeader.split(";");

  for (const pair of pairs) {
    const [name, ...rest] = pair.trim().split("=");
    if (name) {
      const raw = rest.join("=");
      try {
        cookies[name] = decodeURIComponent(raw);
      } catch {
        // Malformed percent-encoded value (e.g. %zz, %2) - fall back to raw value
        cookies[name] = raw;
      }
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
  options: CreateUseFunctionOptions<TEnv>,
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
            `Handles must be used within route/layout handlers.`,
        );
      }

      // Return a push function bound to this handle and segment
      return (
        dataOrFn: unknown | Promise<unknown> | (() => Promise<unknown>),
      ) => {
        // If it's a function, call it immediately to get the promise
        const valueOrPromise =
          typeof dataOrFn === "function"
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
      const fetchable = getFetchableLoader(loader.$$id);
      if (fetchable) {
        loaderFn = fetchable.fn;
      }
    }

    if (!loaderFn) {
      throw new Error(
        `Loader "${loader.$$id}" has no function. This usually means the loader was defined without "use server" and the function was not included in the build.`,
      );
    }

    const ctx = getContext();

    // Create loader context with recursive use() support
    const loaderCtx: LoaderContext<Record<string, string | undefined>, TEnv> = {
      params: ctx.params,
      request: ctx.request,
      searchParams: ctx.searchParams,
      search: (ctx as any).search ?? {},
      pathname: ctx.pathname,
      url: ctx.url,
      env: ctx.env as any,
      var: ctx.var as any,
      get: ctx.get as any,
      use: <TDep, TDepParams = any>(
        dep: LoaderDefinition<TDep, TDepParams>,
      ): Promise<TDep> => {
        // Recursive call - will start dep loader if not already started
        return ctx.use(dep);
      },
      method: "GET",
      body: undefined,
      reverse: createReverseFunction(
        getGlobalRouteMap(),
        ctx._routeName,
        ctx.params as Record<string, string>,
      ),
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
