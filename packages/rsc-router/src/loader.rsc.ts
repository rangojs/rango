/**
 * rsc-router/loader (RSC/server version)
 *
 * Server-side createLoader implementation with full loader functionality.
 * Only used in react-server context via export conditions.
 *
 * For non-fetchable loaders: returns a loader definition with fn included
 * For fetchable loaders: stores fn in registry and returns a serializable loader with action
 *
 * The $$id is injected by the Vite exposeLoaderId plugin as a hidden parameter.
 * Users don't need to pass any name - IDs are auto-generated from file path.
 */

import type {
  FetchableLoaderOptions,
  LoaderDefinition,
  LoaderFn,
} from "./types.js";
import type { MiddlewareFn } from "./router/middleware.js";
import { getRequestContext } from "./server/request-context.js";

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
  { fn: LoaderFn<any, any, any>; middleware: MiddlewareFn[] }
>();

/**
 * Register a fetchable loader's function internally
 * Called during module initialization with the $$id
 */
function registerFetchableLoader(
  id: string,
  fn: LoaderFn<any, any, any>,
  middleware: MiddlewareFn[]
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
): { fn: LoaderFn<any, any, any>; middleware: MiddlewareFn[] } | undefined {
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
  const middleware: MiddlewareFn[] =
    fetchable === true ? [] : fetchable?.middleware || [];

  // Register the function in the internal registry by $$id (server-side only)
  // The server action will look it up by $$id when executed
  if (fn && loaderId) {
    registerFetchableLoader(loaderId, fn, middleware);
  }

  // Create server action for form-based fetching
  // This action is serializable and can be passed to client components
  // The loaderId is captured in closure (it's a primitive string)
  async function loaderAction(formData: FormData): Promise<Awaited<T>> {
    "use server";

    // Look up the loader from registry by $$id
    const registered = fetchableLoaderRegistry.get(loaderId);
    if (!registered) {
      throw new Error(`Loader "${loaderId}" not found in registry`);
    }

    // Get request context (env, request, url, variables) from the RSC handler
    // This is set by runWithRequestContext in rsc/index.ts when executing actions
    const requestCtx = getRequestContext();

    // Convert FormData to params object
    const params: Record<string, string> = {};
    formData.forEach((value, key) => {
      if (typeof value === "string") {
        params[key] = value;
      }
    });

    // Use real request/url from context, or fall back to synthetic for edge cases
    const actionUrl = requestCtx?.url ?? new URL("http://localhost/");
    const actionRequest = requestCtx?.request ?? new Request(actionUrl, { method: "POST" });
    const env = requestCtx?.env ?? {};

    // Merge variables from request context (app-level middleware) with loader-specific variables
    // requestCtx.var is the shared variables object from the handler
    const variables: Record<string, any> = { ...requestCtx?.var };

    // Execute middleware for auth checks (server actions can't return Response)
    // If middleware returns Response, we throw an error
    if (registered.middleware.length > 0) {
      const { executeServerActionMiddleware } = await import(
        "./router/middleware.js"
      );
      await executeServerActionMiddleware(
        registered.middleware,
        actionRequest,
        env,
        params,
        variables
      );
    }

    // Build context using createHandlerContext for consistency with route handlers
    // Pass variables in __middlewareVariables so they're properly shared
    const { createHandlerContext } = await import("./router/handler-context.js");
    const envWithVariables = { ...env, __middlewareVariables: variables };
    const baseCtx = createHandlerContext(
      params,
      actionRequest,
      actionUrl.searchParams,
      actionUrl.pathname,
      actionUrl,
      envWithVariables
    );

    // Extend with server action specific properties
    const ctx: any = {
      ...baseCtx,
      method: "POST",
      formData,
    };

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
