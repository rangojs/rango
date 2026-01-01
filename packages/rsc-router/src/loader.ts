/**
 * rsc-router/loader
 *
 * Client-safe createLoader implementation.
 * This file can be safely imported from both server and client contexts.
 *
 * For non-fetchable loaders: returns a stub loader definition
 * For fetchable loaders: stores fn in registry and returns a serializable loader
 */

import type {
  FetchableLoaderOptions,
  LoaderDefinition,
  LoaderFn,
  MiddlewareFn,
} from "./types.js";

// Internal registry for fetchable loaders (server-side only)
// Maps loader name to its function and middleware
// This allows server actions to look up the loader without capturing it in closure
const fetchableLoaderRegistry = new Map<
  string,
  { fn: LoaderFn<any, any, any>; middleware: MiddlewareFn<any>[] }
>();

/**
 * Register a fetchable loader's function internally
 * Called during module initialization
 */
function registerFetchableLoader(
  name: string,
  fn: LoaderFn<any, any, any>,
  middleware: MiddlewareFn<any>[]
): void {
  fetchableLoaderRegistry.set(name, { fn, middleware });
}

/**
 * Get a fetchable loader's function from registry
 * Called by server actions to execute the loader
 */
export function getFetchableLoader(
  name: string
): { fn: LoaderFn<any, any, any>; middleware: MiddlewareFn<any>[] } | undefined {
  return fetchableLoaderRegistry.get(name);
}

// Overload 1: With function, infer return type (not fetchable)
export function createLoader<T>(
  name: string,
  fn: LoaderFn<T, Record<string, string | undefined>, any>
): LoaderDefinition<Awaited<T>, Record<string, string | undefined>>;

// Overload 2: No function (client-side reference only)
export function createLoader(
  name: string
): LoaderDefinition<any, Record<string, string | undefined>>;

// Overload 3: Fetchable with `true` (no middleware)
export function createLoader<T>(
  name: string,
  fn: LoaderFn<T, Record<string, string | undefined>, any>,
  fetchable: true
): LoaderDefinition<Awaited<T>, Record<string, string | undefined>>;

// Overload 4: Fetchable with middleware
export function createLoader<T>(
  name: string,
  fn: LoaderFn<T, Record<string, string | undefined>, any>,
  options: FetchableLoaderOptions
): LoaderDefinition<Awaited<T>, Record<string, string | undefined>>;

// Implementation
export function createLoader<T>(
  name: string,
  fn?: LoaderFn<T, Record<string, string | undefined>, any>,
  fetchable?: true | FetchableLoaderOptions
): LoaderDefinition<Awaited<T>, Record<string, string | undefined>> {
  // If not fetchable, return a simple stub with fn included
  if (fetchable === undefined) {
    return {
      __brand: "loader",
      name,
      fn: fn as LoaderFn<Awaited<T>, Record<string, string | undefined>, any> | undefined,
    };
  }

  // Fetchable loader - store fn in registry and return a serializable object
  const middleware: MiddlewareFn<any>[] =
    fetchable === true ? [] : fetchable?.middleware || [];

  // Register the function in the internal registry (server-side only)
  // The server action will look it up by name when executed
  if (fn) {
    registerFetchableLoader(name, fn, middleware);
  }

  // Create server action for form-based fetching
  // This action is serializable and can be passed to client components
  async function loaderAction(formData: FormData): Promise<Awaited<T>> {
    "use server";

    // Look up the loader from registry by name
    const registered = fetchableLoaderRegistry.get(name);
    if (!registered) {
      throw new Error(`Loader "${name}" not found in registry`);
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

    // Run middleware chain (middleware expects HandlerContext which is compatible)
    for (const mw of registered.middleware) {
      await mw(ctx, async () => {});
    }

    // Execute and return result
    return registered.fn(ctx);
  }

  // Return a loader object with action for form-based fetching
  // The exposeLoaderId plugin will also add $$id for GET-based fetching
  return {
    __brand: "loader",
    name,
    action: loaderAction,
  };
}
