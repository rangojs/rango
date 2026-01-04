/**
 * rsc-router/loader
 *
 * Client-safe createLoader implementation.
 * This file can be safely imported from both server and client contexts.
 *
 * For non-fetchable loaders: returns a stub loader definition
 * For fetchable loaders: stores fn in registry and returns a serializable loader
 *
 * The $$id is injected by the Vite exposeLoaderId plugin as a hidden parameter.
 * Users don't need to pass any name - IDs are auto-generated from file path.
 */

import type {
  FetchableLoaderOptions,
  LoaderDefinition,
  LoaderFn,
  MiddlewareFn,
} from "./types.js";

/**
 * Execute loader middleware chain with proper next() chaining
 * Returns Response if middleware short-circuits, null otherwise
 */
export async function executeLoaderMiddleware(
  middleware: MiddlewareFn<any>[],
  ctx: any
): Promise<Response | null> {
  if (middleware.length === 0) {
    return null;
  }

  let index = 0;
  let earlyResponse: Response | null = null;

  const next = async (): Promise<void> => {
    if (index >= middleware.length || earlyResponse) {
      return;
    }

    const currentIndex = index++;
    const currentMiddleware = middleware[currentIndex];

    const result = await currentMiddleware(ctx, next);

    if (result instanceof Response) {
      earlyResponse = result;
    }
  };

  await next();
  return earlyResponse;
}

// Internal registry for fetchable loaders (server-side only)
// Maps loader $$id to its function and middleware
//
// WHY TWO REGISTRIES?
// This registry (fetchableLoaderRegistry) is populated immediately when createLoader() runs.
// The other registry in loader-registry.ts (loaderRegistry) is a cache used by the RSC handler
// for GET-based fetching. The RSC handler calls getFetchableLoader() from here to populate
// its cache. This separation allows:
// 1. Server actions to look up loaders directly without going through lazy loading
// 2. The RSC handler to use lazy loading for production builds
// 3. Both to share the same source of truth (this registry)
const fetchableLoaderRegistry = new Map<
  string,
  { fn: LoaderFn<any, any, any>; middleware: MiddlewareFn<any>[] }
>();

/**
 * Register a fetchable loader's function internally
 * Called during module initialization with the $$id
 */
function registerFetchableLoader(
  id: string,
  fn: LoaderFn<any, any, any>,
  middleware: MiddlewareFn<any>[]
): void {
  fetchableLoaderRegistry.set(id, { fn, middleware });
}

/**
 * Get a fetchable loader's function from the internal registry by $$id
 *
 * This is used internally by:
 * - Server actions (loaderAction) to execute loader functions
 * - loader-registry.ts to populate the main registry for GET-based fetching
 *
 * Loaders are registered here when createLoader() is called with fetchable: true.
 * The $$id is injected by the Vite exposeLoaderId plugin.
 *
 * @param id - The loader's $$id (auto-generated from file path + export name)
 * @returns The loader function and middleware, or undefined if not found
 *
 * @internal This is primarily for internal use by the router infrastructure
 */
export function getFetchableLoader(
  id: string
): { fn: LoaderFn<any, any, any>; middleware: MiddlewareFn<any>[] } | undefined {
  return fetchableLoaderRegistry.get(id);
}

// Overload 1: With function only (not fetchable)
export function createLoader<T>(
  fn: LoaderFn<T, Record<string, string | undefined>, any>
): LoaderDefinition<Awaited<T>, Record<string, string | undefined>>;

// Overload 2: Fetchable with `true` (no middleware)
export function createLoader<T>(
  fn: LoaderFn<T, Record<string, string | undefined>, any>,
  fetchable: true
): LoaderDefinition<Awaited<T>, Record<string, string | undefined>>;

// Overload 3: Fetchable with middleware options
export function createLoader<T>(
  fn: LoaderFn<T, Record<string, string | undefined>, any>,
  options: FetchableLoaderOptions
): LoaderDefinition<Awaited<T>, Record<string, string | undefined>>;

// Implementation - the $$id parameter is injected by Vite plugin, not user-provided
export function createLoader<T>(
  fn: LoaderFn<T, Record<string, string | undefined>, any>,
  fetchable?: true | FetchableLoaderOptions,
  // Hidden parameter injected by Vite exposeLoaderId plugin
  __injectedId?: string
): LoaderDefinition<Awaited<T>, Record<string, string | undefined>> {
  // The $$id will be set on the returned object by Vite plugin
  // For fetchable loaders, __injectedId is also passed as a parameter
  const loaderId = __injectedId || "";

  // If not fetchable, return a simple stub with fn included
  if (fetchable === undefined) {
    return {
      __brand: "loader",
      $$id: loaderId,
      fn: fn as LoaderFn<Awaited<T>, Record<string, string | undefined>, any>,
    };
  }

  // Fetchable loader - store fn in registry and return a serializable object
  const middleware: MiddlewareFn<any>[] =
    fetchable === true ? [] : fetchable?.middleware || [];

  // Register the function in the internal registry by $$id (server-side only)
  // The server action will look it up by $$id when executed
  if (fn && loaderId) {
    registerFetchableLoader(loaderId, fn, middleware);
  }

  // Create server action for form-based fetching
  // This action is serializable and can be passed to client components
  // The loaderId is captured in closure (it's a primitive string)
  //
  // IMPORTANT: The signature must be (prevState, formData) for useActionState compatibility.
  // When used with useActionState, React passes the previous state as the first argument.
  // The prevState is ignored here since loaders are stateless data fetchers.
  async function loaderAction(
    _prevState: Awaited<T> | null,
    formData: FormData
  ): Promise<Awaited<T>> {
    "use server";

    // Look up the loader from registry by $$id
    const registered = fetchableLoaderRegistry.get(loaderId);
    if (!registered) {
      throw new Error(`Loader "${loaderId}" not found in registry`);
    }

    // Convert FormData to params object
    const params: Record<string, string> = {};
    formData.forEach((value, key) => {
      if (typeof value === "string") {
        params[key] = value;
      }
    });

    // Build minimal context for the loader
    // Using 'any' to avoid complex type compatibility issues
    const ctx: any = {
      method: "POST",
      params,
      formData,
      searchParams: new URLSearchParams(),
      pathname: "/",
      url: new URL("http://localhost/"),
      request: new Request("http://localhost/", { method: "POST" }),
      get: (key: string) => params[key],
      set: () => {},
      use: () => undefined,
      var: {},
      env: {},
    };

    // Run middleware chain with proper next() chaining
    const middlewareResponse = await executeLoaderMiddleware(
      registered.middleware,
      ctx
    );

    // If middleware returned a Response (e.g., auth redirect), throw error
    // since we can't return a Response from a server action
    if (middlewareResponse) {
      throw new Error(
        `Loader middleware returned a Response. Status: ${middlewareResponse.status}`
      );
    }

    // Execute and return result
    return registered.fn(ctx);
  }

  // Return a loader object with action for form-based fetching
  // The exposeLoaderId plugin will set $$id on this object
  return {
    __brand: "loader",
    $$id: loaderId,
    action: loaderAction,
  };
}
