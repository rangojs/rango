/**
 * Shared logic for executing a fetchable loader as a server action.
 *
 * Called by two server action paths:
 *   1. loader.rsc.ts inline per-loader "use server" action (Flight-serialized loaders)
 *   2. fetchable-loader-action.ts generic "use server" dispatcher (client-imported loaders)
 *
 * Both paths converge here. This function looks up the loader in the registry,
 * builds the handler context from the current request context, runs middleware,
 * and calls the loader handler.
 *
 * Route params (e.g. slug from /blog/:slug) come from requestContext.params,
 * set by setRequestContextParams() in coreRequestHandlerInner before the
 * action executes.
 *
 * This is NOT a "use server" module -- callers provide the server boundary.
 */

import { getLoaderLazy } from "./server/loader-registry.js";
import { getRequestContext } from "./server/request-context.js";

export async function executeLoaderAction(
  loaderId: string,
  formData: FormData,
): Promise<unknown> {
  // Use getLoaderLazy to support production lazy imports.
  // In production, loader modules are code-split into lazy chunks.
  // For loaders not on the current route (e.g. directly imported by client),
  // the module hasn't been imported yet. getLoaderLazy triggers the import
  // via the loader manifest, which runs createLoader and populates the registry.
  const registered = await getLoaderLazy(loaderId);
  if (!registered) {
    throw new Error(`Loader "${loaderId}" not found in registry`);
  }

  const requestCtx = getRequestContext();

  // Use the real request context values. Route params come from route matching
  // (set by setRequestContextParams), NOT from FormData.
  const actionUrl = requestCtx?.url ?? new URL("http://localhost/");
  const actionRequest =
    requestCtx?.request ?? new Request(actionUrl, { method: "POST" });
  const env = requestCtx?.env ?? {};

  // Use the shared variables object directly (same reference as requestCtx.var).
  // This ensures middleware writes are visible to the loader context, since
  // createHandlerContext also reads from getRequestContext()?.var.
  const variables = requestCtx?.var ?? {};

  // Execute loader-specific middleware for auth checks, headers, cookies.
  // Route params are passed so middleware patterns can match.
  // Clone the request so middleware can read the body even if the original
  // was already consumed by server action argument decoding.
  if (registered.middleware.length > 0 && requestCtx?.res) {
    const { executeServerActionMiddleware } =
      await import("./router/middleware.js");
    const { createReverseFunction } =
      await import("./router/handler-context.js");
    const { getGlobalRouteMap } = await import("./route-map-builder.js");
    const middlewareRequest = actionRequest.bodyUsed
      ? new Request(actionRequest.url, {
          method: actionRequest.method,
          headers: actionRequest.headers,
        })
      : actionRequest;
    await executeServerActionMiddleware(
      registered.middleware,
      middlewareRequest,
      env,
      requestCtx?.params ?? {},
      variables,
      requestCtx.res,
      createReverseFunction(getGlobalRouteMap()),
    );
  }

  // Build loader context. Route params come from request context (URL matching),
  // not from FormData. Form data is available separately via ctx.formData.
  const { createHandlerContext } = await import("./router/handler-context.js");
  const { getGlobalRouteMap } = await import("./route-map-builder.js");
  const baseCtx = createHandlerContext(
    requestCtx?.params ?? {},
    actionRequest,
    actionUrl.searchParams,
    actionUrl.pathname,
    actionUrl,
    env,
    getGlobalRouteMap(),
    requestCtx?._routeName,
  );

  const ctx: any = {
    ...baseCtx,
    method: "POST",
    formData,
  };

  // Inherit use() from request context so loader actions can compose other
  // loaders via ctx.use(depLoader). createHandlerContext sets a throwing
  // placeholder; the request context has the real implementation wired to
  // the loader executor and handle store.
  if (requestCtx?.use) {
    ctx.use = requestCtx.use;
  }

  return registered.fn(ctx);
}
