/**
 * rsc-router/loader (client version)
 *
 * Client-only stub for createLoader. Returns a minimal loader definition
 * that can be passed to hooks like useLoader. The actual loader function
 * is not included - it only exists on the server.
 *
 * For fetchable loaders, a server action is created so that load.action
 * works when the loader is directly imported by client components.
 *
 * The $$id is injected by the Vite exposeInternalIds plugin.
 */

import type {
  FetchableLoaderOptions,
  LoaderDefinition,
  LoaderFn,
} from "./types.js";

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

// Implementation - client stub that just returns the loader definition
// The $$id parameter is injected by Vite plugin, not user-provided
export function createLoader<T>(
  _fn: LoaderFn<T, Record<string, string | undefined>, any>,
  _fetchable?: true | FetchableLoaderOptions,
  __injectedId?: string
): LoaderDefinition<Awaited<T>, Record<string, string | undefined>> {
  const loaderId = __injectedId || "";

  if (_fetchable) {
    // For fetchable loaders, create a server action so load.action works
    // when the loader is directly imported by client components.
    // The "use server" directive ensures this function runs on the server
    // where it can access the loader registry and build the full context.
    async function loaderAction(
      _prevState: Awaited<T> | null,
      formData: FormData
    ): Promise<Awaited<T>> {
      "use server";

      const { getFetchableLoader } = await import(
        "./server/fetchable-loader-store.js"
      );
      const { getRequestContext } = await import(
        "./server/request-context.js"
      );
      const { createHandlerContext } = await import(
        "./router/handler-context.js"
      );

      const registered = getFetchableLoader(loaderId);
      if (!registered) {
        throw new Error(`Loader "${loaderId}" not found in registry`);
      }

      const requestCtx = getRequestContext();

      const params: Record<string, string> = {};
      formData.forEach((value, key) => {
        if (typeof value === "string") {
          params[key] = value;
        }
      });

      const actionUrl = requestCtx?.url ?? new URL("http://localhost/");
      const actionRequest =
        requestCtx?.request ?? new Request(actionUrl, { method: "POST" });
      const env = requestCtx?.env ?? {};
      const variables: Record<string, any> = { ...requestCtx?.var };

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

      const baseCtx = createHandlerContext(
        params,
        actionRequest,
        actionUrl.searchParams,
        actionUrl.pathname,
        actionUrl,
        env,
      );

      const ctx: any = { ...baseCtx, method: "POST", formData };
      return registered.fn(ctx);
    }

    return {
      __brand: "loader",
      $$id: loaderId,
      action: loaderAction,
    };
  }

  // Non-fetchable: client only needs the $$id for identification
  return {
    __brand: "loader",
    $$id: loaderId,
  };
}
