/**
 * rsc-router/loader (RSC/server version)
 *
 * Server-side createLoader implementation with full loader functionality.
 * Only used in react-server context via export conditions.
 *
 * For non-fetchable loaders: returns a loader definition with fn included
 * For fetchable loaders: stores fn in registry and returns a serializable loader with action
 *
 * The $$id is injected by the Vite exposeInternalIds plugin as a hidden parameter.
 * Users don't need to pass any name - IDs are auto-generated from file path.
 */

import type {
  FetchableLoaderOptions,
  LoaderDefinition,
  LoaderFn,
} from "./types.js";
import type { MiddlewareFn } from "./router/middleware.js";
import { getRequestContext } from "./server/request-context.js";
import {
  registerFetchableLoader,
  getFetchableLoader,
} from "./server/fetchable-loader-store.js";

export { getFetchableLoader };

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
  // Hidden parameter injected by Vite exposeInternalIds plugin
  __injectedId?: string
): LoaderDefinition<Awaited<T>, Record<string, string | undefined>> {
  // The $$id will be set on the returned object by Vite plugin
  // For fetchable loaders, __injectedId is also passed as a parameter
  const loaderId = __injectedId || "";

  // If not fetchable, store fn in registry and return a plain object.
  // Server-side code looks up fn via getFetchableLoader($$id).
  if (fetchable === undefined) {
    if (fn && loaderId) {
      registerFetchableLoader(loaderId, fn, []);
    }
    return {
      __brand: "loader",
      $$id: loaderId,
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
    const registered = getFetchableLoader(loaderId);
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

    // Execute middleware for auth checks, headers, cookies
    // Headers/cookies set on ctx.res will be merged into the final response
    if (registered.middleware.length > 0 && requestCtx?.res) {
      const { executeServerActionMiddleware } = await import(
        "./router/middleware.js"
      );
      const { createReverseFunction } = await import(
        "./router/handler-context.js"
      );
      const { getGlobalRouteMap } = await import("./route-map-builder.js");
      await executeServerActionMiddleware(
        registered.middleware,
        actionRequest,
        env,
        params,
        variables,
        requestCtx.res,
        createReverseFunction(getGlobalRouteMap()),
      );
    }

    // Build context using createHandlerContext for consistency with route handlers
    // Variables are now accessed from request context via getRequestContext()
    const { createHandlerContext } = await import("./router/handler-context.js");
    const baseCtx = createHandlerContext(
      params,
      actionRequest,
      actionUrl.searchParams,
      actionUrl.pathname,
      actionUrl,
      env
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

  // Return a plain object with action for form-based fetching.
  // loaderAction has "use server" so RSC Flight serializes it natively as a server action reference.
  return {
    __brand: "loader",
    $$id: loaderId,
    action: loaderAction,
  };
}
