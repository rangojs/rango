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
import { DataNotFoundError } from "../errors.js";
import { executeLoaderMiddleware } from "../router/middleware.js";
import { getRequestContext } from "../server/request-context.js";
import { observePhase, PHASES } from "../router/instrument.js";
import {
  createReverseFunction,
  stripInternalParams,
} from "../router/handler-context.js";
import {
  getGlobalRouteMap,
  getSearchSchema,
  isRouteRootScoped,
} from "../route-map-builder.js";
import { parseSearchParams } from "../search-params.js";
import {
  createResponseWithMergedHeaders,
  finalizeResponse,
} from "./helpers.js";
import type { HandlerContext } from "./handler-context.js";

/**
 * Build the 500 RSC error Response for a failed fetchable loader. Shared by the
 * module-load-error catch (the import itself threw) and the loader-execution
 * error catch — both call onError("loader"), serialize the same dev-gated error
 * payload via renderToReadableStream (reporting render failures through
 * onError("rendering")), and return a 500 text/x-component Response. The only
 * per-site difference is the console.error label, passed in.
 */
function buildLoaderErrorResponse<TEnv>(
  ctx: HandlerContext<TEnv>,
  error: unknown,
  meta: { request: Request; url: URL; env: TEnv; loaderId: string },
  logLabel: string,
): Response {
  const { request, url, env, loaderId } = meta;
  const isDev = process.env.NODE_ENV !== "production";

  console.error(logLabel, error);

  ctx.callOnError(error, "loader", {
    request,
    url,
    env,
    loaderName: loaderId,
    handledByBoundary: false,
  });

  const err = error instanceof Error ? error : new Error(String(error));
  const errorPayload = {
    loaderResult: null,
    loaderError: {
      message: isDev ? err.message : "An error occurred",
      // Gate err.name to dev. In production it leaks the consumer's error class
      // name (e.g. AuthError, PrismaClientKnownRequestError) to the client; the
      // client only ever reads `message`, so the field is dead data outside dev.
      // Matches sanitizeError's dev-only name contract.
      name: isDev ? err.name : "Error",
    },
  };
  const rscStream = ctx.renderToReadableStream(errorPayload, {
    onError: (renderError: unknown) => {
      ctx.callOnError(renderError, "rendering", {
        request,
        url,
        env,
        loaderName: loaderId,
      });
    },
  });

  return createResponseWithMergedHeaders(rscStream, {
    status: 500,
    headers: { "content-type": "text/x-component;charset=utf-8" },
  });
}

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

  // Look up loader lazily. getLoaderLazy returns undefined only when the id was
  // never registered (genuine 404). A thrown error means the loader module
  // EXISTS but its import failed (broken transitive import, syntax error, throw
  // in top-level code) — a real server breakage that must surface as a 500 and
  // fire onError, not be collapsed into a misleading "not found".
  let registeredLoader;
  try {
    registeredLoader = await getLoaderLazy(loaderId);
  } catch (error) {
    return buildLoaderErrorResponse(
      ctx,
      error,
      { request, url, env, loaderId },
      `[RSC] Loader module load failed for "${loaderId}":`,
    );
  }
  if (!registeredLoader) {
    return createResponseWithMergedHeaders(
      `Loader "${loaderId}" not found in registry`,
      { status: 404 },
    );
  }

  // Non-fetchable loaders are registered for SSR ctx.use() only.
  // They must not be callable through the standalone _rsc_loader endpoint.
  if (!registeredLoader.fetchable) {
    return createResponseWithMergedHeaders(
      `Loader "${loaderId}" is not fetchable`,
      { status: 403 },
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
          const reqCtx = getRequestContext();
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
              reqCtx._routeName
                ? isRouteRootScoped(reqCtx._routeName)
                : undefined,
            ),
            ...(loaderFormData ? { formData: loaderFormData } : {}),
          };

          // Meter the fetchable-loader execution via observePhase, the sole
          // funnel for this path (fn is called directly, not via ctx.use).
          // depth:1 — a fetchable request has no render-phase parent.
          const result = await observePhase(PHASES.loader(loaderId, 1), () =>
            fn(loaderCtx),
          );

          interface LoaderPayload {
            loaderResult: unknown;
          }
          const loaderPayload: LoaderPayload = { loaderResult: result };
          const rscStream = ctx.renderToReadableStream<LoaderPayload>(
            loaderPayload,
            {
              onError: (error: unknown) => {
                ctx.callOnError(error, "rendering", {
                  request,
                  url,
                  env,
                  loaderName: loaderId,
                });
              },
            },
          );

          return createResponseWithMergedHeaders(rscStream, {
            headers: { "content-type": "text/x-component;charset=utf-8" },
          });
        },
        createReverseFunction(ctx.getRequiredRouteMap()),
      ),
    );
  } catch (error) {
    // A thrown Response is control flow, not an error: `throw redirect('/x')`
    // throws a real Response (a 3xx). The with-middleware path already converts
    // this to a returned Response (middleware.ts: `if (error instanceof Response)
    // result = error`), but a fetchable loader with NO middleware reaches this
    // catch directly, where the generic Error coercion below would turn it into a
    // 500. Honor it the same way: re-wrap through createResponseWithMergedHeaders
    // so the request context's stub cookies/headers merge, exactly like the
    // returned-Response path. Mirrors rsc/handler.ts's `error instanceof Response`
    // special-case.
    if (error instanceof Response) {
      return finalizeResponse(
        createResponseWithMergedHeaders(error.body, {
          status: error.status,
          headers: error.headers,
        }),
      );
    }

    // notFound() throws a DataNotFoundError (an Error subclass, NOT a Response),
    // so it does not match the branch above. Map it to a 404 before the generic
    // 500 coercion so a no-middleware fetchable loader's notFound() is honored
    // (the with-middleware path resolves it through the notFoundBoundary).
    if (error instanceof DataNotFoundError) {
      return finalizeResponse(
        createResponseWithMergedHeaders(null, { status: 404 }),
      );
    }

    return buildLoaderErrorResponse(
      ctx,
      error,
      { request, url, env, loaderId },
      "[RSC] Loader error:",
    );
  }
}
