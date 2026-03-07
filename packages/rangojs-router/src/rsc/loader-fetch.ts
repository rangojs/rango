/**
 * Loader Fetch Handler
 *
 * Handles load() requests (GET, POST, PUT, PATCH, DELETE) from the client.
 * All loader data fetching and mutations go through this endpoint.
 *
 * Route params (e.g. slug from /blog/:slug) come from previewMatch() in the
 * outer coreRequestHandler, threaded through coreRequestHandlerInner as
 * routeParams. This is necessary because handleLoaderFetch doesn't do its
 * own route matching -- the URL is the page's pathname, and previewMatch
 * has already extracted params from it.
 */

import { getLoaderLazy } from "../server/loader-registry.js";
import { executeLoaderMiddleware } from "../router/middleware.js";
import { requireRequestContext } from "../server/request-context.js";
import {
  createReverseFunction,
  stripInternalParams,
} from "../router/handler-context.js";
import { getGlobalRouteMap, getSearchSchema } from "../route-map-builder.js";
import { parseSearchParams } from "../search-params.js";
import {
  createResponseWithMergedHeaders,
  finalizeResponse,
} from "./helpers.js";
import type { HandlerContext } from "./handler-context.js";

export async function handleLoaderFetch<TEnv>(
  ctx: HandlerContext<TEnv>,
  request: Request,
  env: TEnv,
  url: URL,
  variables: Record<string, any>,
  routeParams?: Record<string, string>,
): Promise<Response> {
  const loaderId = url.searchParams.get("_rsc_loader");

  if (!loaderId) {
    return createResponseWithMergedHeaders("Missing _rsc_loader parameter", {
      status: 400,
    });
  }

  // Look up loader lazily
  const registeredLoader = await getLoaderLazy(loaderId);
  if (!registeredLoader) {
    return createResponseWithMergedHeaders(
      `Loader "${loaderId}" not found in registry`,
      { status: 404 },
    );
  }

  // Parse params, body, and formData based on request method and content type
  let loaderParams: Record<string, string> = {};
  let loaderBody: unknown = undefined;
  let loaderFormData: FormData | undefined;
  const isBodyMethod = request.method !== "GET" && request.method !== "HEAD";

  if (isBodyMethod) {
    try {
      const contentType = request.headers.get("content-type") || "";
      if (contentType.includes("multipart/form-data")) {
        // FormData body — sent by load() when body is a FormData instance.
        // Preserves File objects and binary data.
        loaderFormData = await request.formData();
        // Extract params if provided via the special field
        const paramsField = loaderFormData.get("_rsc_loader_params");
        if (typeof paramsField === "string") {
          loaderParams = JSON.parse(paramsField);
          loaderFormData.delete("_rsc_loader_params");
        }
      } else if (contentType.includes("application/json")) {
        const jsonBody = (await request.json()) as {
          params?: Record<string, string>;
          body?: unknown;
        };
        loaderParams = jsonBody.params ?? {};
        loaderBody = jsonBody.body;
      }
    } catch {
      return createResponseWithMergedHeaders("Invalid request body", {
        status: 400,
      });
    }
  } else {
    const loaderParamsJson = url.searchParams.get("_rsc_loader_params");
    if (loaderParamsJson) {
      try {
        loaderParams = JSON.parse(loaderParamsJson);
      } catch {
        return createResponseWithMergedHeaders(
          "Invalid _rsc_loader_params JSON",
          { status: 400 },
        );
      }
    }
  }

  // Execute the loader with middleware.
  // finalizeResponse drains onResponse callbacks that middleware short-circuits
  // may leave behind (executeLoaderMiddleware does not finalize them itself).
  try {
    const { fn, middleware } = registeredLoader;

    return finalizeResponse(
      await executeLoaderMiddleware(
        middleware,
        request,
        env,
        loaderParams,
        variables,
        async () => {
          const reqCtx = requireRequestContext();
          // Merge route params (from previewMatch) with explicit loader params.
          // Explicit params take precedence over route-matched params.
          const resolvedRouteParams = routeParams ?? {};
          const mergedParams = {
            ...resolvedRouteParams,
            ...loaderParams,
          };
          // Strip _rsc_* transport params so loaders see the same
          // url/searchParams as during SSR/navigation.
          const cleanUrl = stripInternalParams(url);
          const cleanSearchParams = cleanUrl.searchParams;
          const searchSchema = reqCtx._routeName
            ? getSearchSchema(reqCtx._routeName)
            : undefined;
          const loaderCtx: any = {
            ...reqCtx,
            url: cleanUrl,
            pathname: cleanUrl.pathname,
            searchParams: cleanSearchParams,
            search: searchSchema
              ? parseSearchParams(cleanSearchParams, searchSchema)
              : {},
            params: mergedParams,
            routeParams: resolvedRouteParams,
            body: loaderBody,
            method: request.method,
            reverse: createReverseFunction(
              getGlobalRouteMap(),
              reqCtx._routeName,
              mergedParams,
            ),
            ...(loaderFormData ? { formData: loaderFormData } : {}),
          };

          const result = await fn(loaderCtx);

          interface LoaderPayload {
            loaderResult: unknown;
          }
          const loaderPayload: LoaderPayload = { loaderResult: result };
          const rscStream =
            ctx.renderToReadableStream<LoaderPayload>(loaderPayload);

          return createResponseWithMergedHeaders(rscStream, {
            headers: { "content-type": "text/x-component;charset=utf-8" },
          });
        },
        createReverseFunction(ctx.getRequiredRouteMap()),
      ),
    );
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    const isDev = process.env.NODE_ENV !== "production";

    console.error("[RSC] Loader error:", error);

    ctx.callOnError(error, "loader", {
      request,
      url,
      env,
      loaderName: loaderId,
      handledByBoundary: false,
    });

    const errorPayload = {
      loaderResult: null,
      loaderError: {
        message: isDev ? err.message : "An error occurred",
        name: err.name,
      },
    };
    const rscStream = ctx.renderToReadableStream(errorPayload);

    return createResponseWithMergedHeaders(rscStream, {
      status: 500,
      headers: { "content-type": "text/x-component;charset=utf-8" },
    });
  }
}
