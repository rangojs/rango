/**
 * Shared logic for executing a fetchable loader via server action.
 *
 * Called by both:
 * - loader.rsc.ts: inline per-loader "use server" action (Flight-serialized)
 * - fetchable-loader-action.ts: generic "use server" dispatcher (client stub import)
 *
 * This is NOT a "use server" module — callers provide the server boundary.
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
  const actionRequest = requestCtx?.request ?? new Request(actionUrl, { method: "POST" });
  const env = requestCtx?.env ?? {};

  // Use the shared variables object directly (same reference as requestCtx.var).
  // This ensures middleware writes are visible to the loader context, since
  // createHandlerContext also reads from getRequestContext()?.var.
  const variables = requestCtx?.var ?? {};

  // Execute loader-specific middleware for auth checks, headers, cookies.
  // Route params are passed so middleware patterns can match.
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
      requestCtx?.params ?? {},
      variables,
      requestCtx.res,
      createReverseFunction(getGlobalRouteMap()),
    );
  }

  // Build loader context. Route params come from request context (URL matching),
  // not from FormData. Form data is available separately via ctx.formData.
  const { createHandlerContext } = await import("./router/handler-context.js");
  const baseCtx = createHandlerContext(
    requestCtx?.params ?? {},
    actionRequest,
    actionUrl.searchParams,
    actionUrl.pathname,
    actionUrl,
    env,
  );

  const ctx: any = {
    ...baseCtx,
    method: "POST",
    formData,
  };

  return registered.fn(ctx);
}
