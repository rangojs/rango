/// <reference types="@vitejs/plugin-rsc/types" />
/**
 * RSC Request Handler
 *
 * Main request handler for RSC rendering, server actions, loader fetching,
 * and progressive enhancement (no-JS form submissions).
 */

import { renderSegments } from "../segment-system.js";
import { RouteNotFoundError } from "../errors.js";
import { getLoaderLazy } from "../server/loader-registry.js";
import {
  matchMiddleware,
  executeMiddleware,
  executeLoaderMiddleware,
} from "../router/middleware.js";
import {
  runWithRequestContext,
  setRequestContextParams,
  requireRequestContext,
  createRequestContext,
} from "../server/request-context.js";
import * as rscDeps from "@vitejs/plugin-rsc/rsc";


import type {
  RscPayload,
  ReactFormState,
  CreateRSCHandlerOptions,
} from "./types.js";
import { hasBodyContent, createResponseWithMergedHeaders } from "./helpers.js";
import { generateNonce } from "./nonce.js";

/**
 * Create an RSC request handler.
 *
 * @example Basic usage (deps and loadSSRModule have sensible defaults)
 * ```tsx
 * import { createRSCHandler } from "rsc-router/rsc";
 * import { router } from "./router.js";
 *
 * export default createRSCHandler({ router });
 * ```
 *
 * @example With custom deps (advanced)
 * ```tsx
 * import { createRSCHandler } from "rsc-router/rsc";
 * import * as rsc from "@vitejs/plugin-rsc/rsc";
 * import { router } from "./router.js";
 *
 * export default createRSCHandler({
 *   router,
 *   deps: rsc,
 *   loadSSRModule: () => import.meta.viteRsc.loadModule("ssr", "index"),
 * });
 * ```
 */
export function createRSCHandler<TEnv = unknown>(
  options: CreateRSCHandlerOptions<TEnv>
) {
  const { router, version, nonce: nonceProvider } = options;

  // Use provided deps or default to @vitejs/plugin-rsc/rsc exports
  const deps = options.deps ?? rscDeps;
  const {
    renderToReadableStream,
    decodeReply,
    createTemporaryReferenceSet,
    loadServerAction,
    decodeAction,
    decodeFormState,
  } = deps;

  // Use provided loadSSRModule or default to vite RSC module loader
  const loadSSRModule =
    options.loadSSRModule ??
    (() => import.meta.viteRsc.loadModule("ssr", "index"));

  return async function handler(
    request: Request,
    env: TEnv = {} as TEnv
  ): Promise<Response> {
    // Resolve nonce if provider is set
    let nonce: string | undefined;
    if (nonceProvider) {
      const result = await nonceProvider(request, env);
      nonce = result === true ? generateNonce() : result;
    }

    const url = new URL(request.url);

    // Match global middleware
    const matchedMiddleware = matchMiddleware(url.pathname, router.middleware);

    // Shared variables between middleware and route handlers
    const variables: Record<string, any> = {};

    // Resolve cache store configuration
    // Priority: options.cache (handler override) > router.cache (router default)
    // Store is enabled only if: config provided, enabled, and no ?__no_cache query param
    let cacheStore = undefined;
    const cacheOption = options.cache ?? router.cache;
    if (cacheOption && !url.searchParams.has("__no_cache")) {
      const cacheConfig =
        typeof cacheOption === "function" ? cacheOption(env) : cacheOption;

      if (cacheConfig.enabled !== false) {
        cacheStore = cacheConfig.store;
      }
    }

    // Store nonce in variables so middleware can access via ctx.get('nonce')
    if (nonce) {
      variables.nonce = nonce;
    }

    // Create unified request context with all methods
    // Includes: stub response, handle store, loader memoization, use(), cookies, headers, cache store
    // params starts empty, populated after route matching via setRequestContextParams
    const requestContext = createRequestContext({
      env,
      request,
      url,
      variables,
      cacheStore,
    });

    // Wrap entire request handling in request context
    // Makes context available via getRequestContext() throughout:
    // - Middleware execution
    // - Route handlers and loaders
    // - Server components during rendering
    // - Error boundaries
    // - Streaming
    return runWithRequestContext(requestContext, async () => {
      // Core handler logic (wrapped by middleware)
      const coreHandler = async (): Promise<Response> => {
        return coreRequestHandler(request, env, url, variables, nonce);
      };

      // Execute middleware chain if any, otherwise call core handler directly
      if (matchedMiddleware.length > 0) {
        return executeMiddleware(
          matchedMiddleware,
          request,
          env,
          variables,
          coreHandler
        );
      }

      return coreHandler();
    });
  };

  // Core request handling logic (separated for middleware wrapping)
  async function coreRequestHandler(
    request: Request,
    env: TEnv,
    url: URL,
    variables: Record<string, any>,
    nonce: string | undefined
  ): Promise<Response> {
    // First, check for route-level middleware
    const preview = await router.previewMatch(request, env);
    if (preview?.routeMiddleware && preview.routeMiddleware.length > 0) {
      // Convert route middleware to app middleware format for execution
      const middlewareEntries = preview.routeMiddleware.map((mw) => ({
        entry: {
          pattern: null,
          regex: null,
          paramNames: [],
          handler: mw.handler,
          mountPrefix: null,
        },
        params: mw.params,
      }));

      // Execute route middleware wrapping the actual request handling
      return executeMiddleware(middlewareEntries, request, env, variables, () =>
        coreRequestHandlerInner(request, env, url, variables, nonce)
      );
    }

    // No route middleware, proceed directly
    return coreRequestHandlerInner(request, env, url, variables, nonce);
  }

  // Inner request handler (actual RSC logic, wrapped by route middleware if any)
  async function coreRequestHandlerInner(
    request: Request,
    env: TEnv,
    url: URL,
    variables: Record<string, any>,
    nonce: string | undefined
  ): Promise<Response> {
    // Early return for static file requests that don't need RSC handling
    if (url.pathname === "/favicon.ico" || url.pathname === "/robots.txt") {
      return new Response(null, { status: 404 });
    }

    const isPartial = url.searchParams.has("_rsc_partial");
    const isAction =
      request.headers.has("rsc-action") || url.searchParams.has("_rsc_action");
    const actionId =
      request.headers.get("rsc-action") || url.searchParams.get("_rsc_action");

    // Version mismatch detection - client may have stale code after HMR/deployment
    // If versions don't match, tell the client to reload
    const clientVersion = url.searchParams.get("_rsc_v");
    if (version && clientVersion && clientVersion !== version) {
      console.log(
        `[RSC] Version mismatch: client=${clientVersion}, server=${version}. Forcing reload.`
      );

      // Clean URL by removing RSC params
      const cleanUrl = new URL(url);
      cleanUrl.searchParams.delete("_rsc_partial");
      cleanUrl.searchParams.delete("_rsc_segments");
      cleanUrl.searchParams.delete("_rsc_v");
      cleanUrl.searchParams.delete("_rsc_stale");
      cleanUrl.searchParams.delete("_rsc_action");
      cleanUrl.searchParams.delete("_rsc_prev");

      // For actions, reload current page (referer)
      // For navigation, load the target URL
      const reloadUrl = isAction
        ? request.headers.get("referer") || cleanUrl.toString()
        : cleanUrl.toString();

      // Return special response that tells client to reload
      return createResponseWithMergedHeaders(null, {
        status: 200,
        headers: {
          "X-RSC-Reload": reloadUrl,
          "content-type": "text/x-component;charset=utf-8",
        },
      });
    }

    // Get handle store from request context (created at start of request)
    const handleStore = requireRequestContext()._handleStore;

    try {
      // ============================================================================
      // PROGRESSIVE ENHANCEMENT: No-JS Form Submissions
      // ============================================================================
      const progressiveResult = await handleProgressiveEnhancement(
        request,
        env,
        url,
        isAction,
        handleStore,
        nonce
      );
      if (progressiveResult) {
        return progressiveResult;
      }

      // ============================================================================
      // SERVER ACTION EXECUTION (JavaScript-enabled client)
      // ============================================================================
      if (isAction && actionId) {
        return handleServerAction(request, env, url, actionId, handleStore);
      }

      // ============================================================================
      // LOADER FETCH EXECUTION (data fetching with RSC serialization)
      // ============================================================================
      const isLoaderRequest = url.searchParams.has("_rsc_loader");
      if (isLoaderRequest) {
        return handleLoaderFetch(request, env, url, variables);
      }

      // ============================================================================
      // REGULAR RSC RENDERING (Navigation)
      // ============================================================================
      return handleRscRendering(request, env, url, isPartial, handleStore, nonce);
    } catch (error) {
      // Check if middleware/handler returned Response
      if (error instanceof Response) {
        return error;
      }

      // Return 404 for unmatched routes instead of 500
      if (error instanceof RouteNotFoundError) {
        return createResponseWithMergedHeaders("Not Found", { status: 404 });
      }

      console.error(`[RSC] Error:`, error);
      throw error;
    }
  }

  // ============================================================================
  // PROGRESSIVE ENHANCEMENT HANDLER
  // When JavaScript is disabled, React renders forms with hidden fields
  // ($ACTION_REF_*, $ACTION_KEY) containing the action reference.
  // We detect these and return HTML instead of RSC stream.
  // ============================================================================
  async function handleProgressiveEnhancement(
    request: Request,
    env: TEnv,
    url: URL,
    isAction: boolean,
    handleStore: ReturnType<typeof requireRequestContext>["_handleStore"],
    nonce: string | undefined
  ): Promise<Response | null> {
    const contentType = request.headers.get("content-type") || "";
    const isFormSubmission =
      contentType.includes("multipart/form-data") ||
      contentType.includes("application/x-www-form-urlencoded");

    if (request.method !== "POST" || isAction || !isFormSubmission) {
      return null;
    }

    // Clone the request to read FormData without consuming it
    const formData = await request.clone().formData();

    // Look for React's progressive enhancement hidden fields
    let isDirectAction = false;
    let isUseActionState = false;
    let directActionId: string | null = null;

    formData.forEach((_value, key) => {
      if (key.startsWith("$ACTION_ID_")) {
        isDirectAction = true;
        directActionId = key.slice("$ACTION_ID_".length);
      } else if (key.startsWith("$ACTION_REF_")) {
        isUseActionState = true;
      }
    });

    if (!isDirectAction && !isUseActionState) {
      return null;
    }

    // Execute action and return HTML
    let actionResult: unknown = undefined;
    let reactFormState: ReactFormState | null = null;

    if (isUseActionState) {
      try {
        const boundAction = await decodeAction(formData);
        actionResult = await boundAction();
      } catch (error) {
        console.error("[RSC] Progressive enhancement action error:", error);
      }
    } else if (isDirectAction && directActionId) {
      const temporaryReferences = createTemporaryReferenceSet();

      let args: unknown[] = [];
      try {
        args = await decodeReply(formData, { temporaryReferences });
      } catch {
        args = [formData];
      }

      try {
        const loadedAction = await loadServerAction(directActionId);
        actionResult = await loadedAction.apply(null, args);
      } catch (error) {
        console.error("[RSC] Progressive enhancement action error:", error);
      }
    }

    // Decode form state for useActionState progressive enhancement
    try {
      reactFormState = await decodeFormState(actionResult, formData);
    } catch (error) {
      console.error("[RSC] Failed to decode form state:", error);
    }

    // Re-render the page and return HTML
    const renderRequest = new Request(url.toString(), {
      method: "GET",
      headers: new Headers({ accept: "text/html" }),
    });

    const match = await router.match(renderRequest, env);

    if (match.redirect) {
      return new Response(null, {
        status: 308,
        headers: { Location: match.redirect },
      });
    }

    const root = renderSegments(match.segments, {
      rootLayout: router.rootLayout,
    });

    const payload: RscPayload = {
      root,
      metadata: {
        pathname: url.pathname,
        segments: match.segments,
        matched: match.matched,
        diff: match.diff,
        isPartial: false,
        rootLayout: router.rootLayout,
        handles: handleStore.stream(),
        version,
      },
      formState: actionResult,
    };

    const rscStream = renderToReadableStream<RscPayload>(payload);
    const ssrModule = await loadSSRModule();
    const htmlStream = await ssrModule.renderHTML(rscStream, {
      formState: reactFormState,
      nonce,
    });

    return new Response(htmlStream, {
      headers: { "content-type": "text/html;charset=utf-8" },
    });
  }

  // ============================================================================
  // SERVER ACTION HANDLER
  // ============================================================================
  async function handleServerAction(
    request: Request,
    env: TEnv,
    url: URL,
    actionId: string,
    handleStore: ReturnType<typeof requireRequestContext>["_handleStore"]
  ): Promise<Response> {
    const temporaryReferences = createTemporaryReferenceSet();

    // Decode action arguments from request body
    const contentType = request.headers.get("content-type") || "";
    let args: unknown[] = [];
    let actionFormData: FormData | undefined;

    try {
      const body = contentType.includes("multipart/form-data")
        ? await request.formData()
        : await request.text();

      if (body instanceof FormData) {
        actionFormData = body;
      }

      if (hasBodyContent(body)) {
        args = await decodeReply(body, { temporaryReferences });
      }
    } catch (error) {
      throw new Error(`Failed to decode action arguments: ${error}`, {
        cause: error,
      });
    }

    // Execute the server action
    let returnValue: { ok: boolean; data: unknown };
    let actionStatus = 200;
    let loadedAction: Function | undefined;

    try {
      loadedAction = await loadServerAction(actionId);
      const data = await loadedAction!.apply(null, args);
      returnValue = { ok: true, data };
    } catch (error) {
      returnValue = { ok: false, data: error };
      actionStatus = 500;

      // Try to render error boundary
      const errorResult = await router.matchError(request, env, error, "route");

      if (errorResult) {
        setRequestContextParams(errorResult.params);

        const payload: RscPayload = {
          root: null,
          metadata: {
            pathname: url.pathname,
            segments: errorResult.segments,
            isPartial: true,
            matched: errorResult.matched,
            diff: errorResult.diff,
            isError: true,
            handles: handleStore.stream(),
            version,
          },
          returnValue,
        };

        const rscStream = renderToReadableStream<RscPayload>(payload, {
          temporaryReferences,
        });

        return createResponseWithMergedHeaders(rscStream, {
          status: actionStatus,
          headers: { "content-type": "text/x-component;charset=utf-8" },
        });
      }
    }

    // Revalidate after action
    const resolvedActionId =
      (loadedAction as { $id?: string; $$id?: string } | undefined)?.$id ??
      (loadedAction as { $$id?: string } | undefined)?.$$id ??
      actionId;
    const actionContext = {
      actionId: resolvedActionId,
      actionUrl: new URL(request.url),
      actionResult: returnValue.data,
      formData: actionFormData,
    };

    const matchResult = await router.matchPartial(request, env, actionContext);

    if (!matchResult) {
      // Fall back to full render
      const fullMatch = await router.match(request, env);
      setRequestContextParams(fullMatch.params);

      if (fullMatch.redirect) {
        return createResponseWithMergedHeaders(null, {
          status: 308,
          headers: { Location: fullMatch.redirect },
        });
      }

      const renderStart = performance.now();
      const root = renderSegments(fullMatch.segments, {
        rootLayout: router.rootLayout,
        isAction: true,
      });
      const renderDuration = performance.now() - renderStart;
      const serverTiming = fullMatch.serverTiming
        ? `${fullMatch.serverTiming}, rendering;dur=${renderDuration.toFixed(2)}`
        : `rendering;dur=${renderDuration.toFixed(2)}`;

      const payload: RscPayload = {
        root,
        metadata: {
          pathname: url.pathname,
          segments: fullMatch.segments,
          matched: fullMatch.matched,
          diff: fullMatch.diff,
          handles: handleStore.stream(),
          version,
        },
        returnValue,
      };

      const rscStream = renderToReadableStream<RscPayload>(payload, {
        temporaryReferences,
      });

      const headers: Record<string, string> = {
        "content-type": "text/x-component;charset=utf-8",
      };
      if (serverTiming) {
        headers["Server-Timing"] = serverTiming;
      }

      return createResponseWithMergedHeaders(rscStream, {
        status: actionStatus,
        headers,
      });
    }

    // Return updated segments
    setRequestContextParams(matchResult.params);

    const renderStart = performance.now();
    renderSegments(matchResult.segments, { rootLayout: router.rootLayout, isAction: true });
    const renderDuration = performance.now() - renderStart;
    const serverTiming = matchResult.serverTiming
      ? `${matchResult.serverTiming}, rendering;dur=${renderDuration.toFixed(2)}`
      : `rendering;dur=${renderDuration.toFixed(2)}`;

    const payload: RscPayload = {
      root: null,
      metadata: {
        pathname: url.pathname,
        segments: matchResult.segments,
        isPartial: true,
        matched: matchResult.matched,
        diff: matchResult.diff,
        slots: matchResult.slots,
        handles: handleStore.stream(),
        version,
      },
      returnValue,
    };

    const rscStream = renderToReadableStream<RscPayload>(payload, {
      temporaryReferences,
    });

    const actionHeaders: Record<string, string> = {
      "content-type": "text/x-component;charset=utf-8",
    };
    if (serverTiming) {
      actionHeaders["Server-Timing"] = serverTiming;
    }

    return createResponseWithMergedHeaders(rscStream, {
      status: actionStatus,
      headers: actionHeaders,
    });
  }

  // ============================================================================
  // LOADER FETCH HANDLER
  // Supports GET (params in query string) and POST/PUT/PATCH/DELETE (JSON body)
  // ============================================================================
  async function handleLoaderFetch(
    request: Request,
    env: TEnv,
    url: URL,
    variables: Record<string, any>
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
        { status: 404 }
      );
    }

    // Parse params and body based on request method
    let loaderParams: Record<string, string> = {};
    let loaderBody: unknown = undefined;
    const isBodyMethod = request.method !== "GET" && request.method !== "HEAD";

    if (isBodyMethod) {
      try {
        const contentType = request.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const jsonBody = (await request.json()) as {
            params?: Record<string, string>;
            body?: unknown;
          };
          loaderParams = jsonBody.params ?? {};
          loaderBody = jsonBody.body;
        }
      } catch {
        return createResponseWithMergedHeaders("Invalid JSON body", {
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
            { status: 400 }
          );
        }
      }
    }

    // Execute the loader with middleware
    try {
      const { fn, middleware } = registeredLoader;

      return await executeLoaderMiddleware(
        middleware,
        request,
        env,
        loaderParams,
        variables,
        async () => {
          const ctx = requireRequestContext();
          const loaderCtx: any = {
            ...ctx,
            params: loaderParams,
            body: loaderBody,
          };

          const result = await fn(loaderCtx);

          interface LoaderPayload {
            loaderResult: unknown;
          }
          const loaderPayload: LoaderPayload = { loaderResult: result };
          const rscStream =
            renderToReadableStream<LoaderPayload>(loaderPayload);

          return createResponseWithMergedHeaders(rscStream, {
            headers: { "content-type": "text/x-component;charset=utf-8" },
          });
        }
      );
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const isDev = process.env.NODE_ENV !== "production";

      console.error("[RSC] Loader error:", error);

      if (router.onError) {
        try {
          router.onError({
            error: err,
            phase: "loader",
            request,
            url,
            pathname: url.pathname,
            method: request.method,
            env,
            loaderName: loaderId,
          });
        } catch (callbackError) {
          console.error("[RSC] onError callback failed:", callbackError);
        }
      }

      const errorPayload = {
        loaderResult: null,
        loaderError: {
          message: isDev ? err.message : "An error occurred",
          name: err.name,
        },
      };
      const rscStream = renderToReadableStream(errorPayload);

      return createResponseWithMergedHeaders(rscStream, {
        status: 500,
        headers: { "content-type": "text/x-component;charset=utf-8" },
      });
    }
  }

  // ============================================================================
  // RSC RENDERING HANDLER (Navigation)
  // ============================================================================
  async function handleRscRendering(
    request: Request,
    env: TEnv,
    url: URL,
    isPartial: boolean,
    handleStore: ReturnType<typeof requireRequestContext>["_handleStore"],
    nonce: string | undefined
  ): Promise<Response> {
    let payload: RscPayload;
    let serverTiming: string | undefined;

    if (isPartial) {
      // Partial render (navigation)
      const result = await router.matchPartial(request, env);

      if (!result) {
        // Fall back to full render
        const match = await router.match(request, env);
        setRequestContextParams(match.params);

        if (match.redirect) {
          return createResponseWithMergedHeaders(null, {
            status: 308,
            headers: { Location: match.redirect },
          });
        }

        const renderStart = performance.now();
        const root = renderSegments(match.segments, {
          rootLayout: router.rootLayout,
        });
        const renderDuration = performance.now() - renderStart;
        serverTiming = match.serverTiming
          ? `${match.serverTiming}, rendering;dur=${renderDuration.toFixed(2)}`
          : `rendering;dur=${renderDuration.toFixed(2)}`;

        payload = {
          root,
          metadata: {
            pathname: url.pathname,
            segments: match.segments,
            matched: match.matched,
            diff: match.diff,
            isPartial: false,
            handles: handleStore.stream(),
            version,
          },
        };
      } else {
        setRequestContextParams(result.params);
        serverTiming = result.serverTiming;

        payload = {
          root: null,
          metadata: {
            pathname: url.pathname,
            segments: result.segments,
            matched: result.matched,
            diff: result.diff,
            isPartial: true,
            slots: result.slots,
            handles: handleStore.stream(),
            version,
          },
        };
      }
    } else {
      // Full render (initial page load)
      const match = await router.match(request, env);
      setRequestContextParams(match.params);

      if (match.redirect) {
        return createResponseWithMergedHeaders(null, {
          status: 308,
          headers: { Location: match.redirect },
        });
      }

      // Caching is now handled in router.match() via cache provider in request context
      // match.segments already contains cached or fresh segments as appropriate

      const renderStart = performance.now();
      const root = renderSegments(match.segments, {
        rootLayout: router.rootLayout,
      });
      const renderDuration = performance.now() - renderStart;
      serverTiming = match.serverTiming
        ? `${match.serverTiming}, rendering;dur=${renderDuration.toFixed(2)}`
        : `rendering;dur=${renderDuration.toFixed(2)}`;

      payload = {
        root,
        metadata: {
          pathname: url.pathname,
          segments: match.segments,
          matched: match.matched,
          diff: match.diff,
          isPartial: false,
          rootLayout: router.rootLayout,
          handles: handleStore.stream(),
          version,
        },
      };
    }

    // Serialize to RSC stream
    const rscStream = renderToReadableStream<RscPayload>(payload);

    // Determine if this is an RSC request or HTML request
    const isRscRequest =
      (!request.headers.get("accept")?.includes("text/html") &&
        !url.searchParams.has("__html")) ||
      url.searchParams.has("__rsc");

    if (isRscRequest) {
      const rscHeaders: Record<string, string> = {
        "content-type": "text/x-component;charset=utf-8",
        vary: "accept",
      };
      if (serverTiming) {
        rscHeaders["Server-Timing"] = serverTiming;
      }
      return createResponseWithMergedHeaders(rscStream, {
        headers: rscHeaders,
      });
    }

    // Delegate to SSR for HTML response
    const ssrModule = await loadSSRModule();
    const htmlStream = await ssrModule.renderHTML(rscStream, { nonce });

    const htmlHeaders: Record<string, string> = {
      "content-type": "text/html;charset=utf-8",
    };
    if (serverTiming) {
      htmlHeaders["Server-Timing"] = serverTiming;
    }

    return createResponseWithMergedHeaders(htmlStream, {
      headers: htmlHeaders,
    });
  }
}
