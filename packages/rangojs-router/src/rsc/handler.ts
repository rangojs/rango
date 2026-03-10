/// <reference types="@vitejs/plugin-rsc/types" />
/// <reference path="../vite/plugins/version.d.ts" />
/**
 * RSC Request Handler
 *
 * Main request handler for RSC rendering, server actions, loader fetching,
 * and progressive enhancement (no-JS form submissions).
 */

import { createElement } from "react";
import { RouteNotFoundError } from "../errors.js";
import { matchMiddleware, executeMiddleware } from "../router/middleware.js";
import {
  runWithRequestContext,
  setRequestContextParams,
  requireRequestContext,
  createRequestContext,
} from "../server/request-context.js";
import * as rscDeps from "@vitejs/plugin-rsc/rsc";

import type { RscPayload, CreateRSCHandlerOptions } from "./types.js";
import {
  createResponseWithMergedHeaders,
  finalizeResponse,
  interceptRedirectForPartial,
  buildRouteMiddlewareEntries,
} from "./helpers.js";
import {
  handleResponseRoute,
  type ResponseRouteMatch,
} from "./response-route-handler.js";
import { generateNonce, nonce as nonceToken } from "./nonce.js";
import { VERSION } from "@rangojs/router:version";
import type { ErrorPhase } from "../types.js";
import type { RouterRequestInput } from "../router/router-interfaces.js";
import { invokeOnError } from "../router/error-handling.js";
import {
  createReverseFunction,
  stripInternalParams,
} from "../router/handler-context.js";
import { getRouterContext } from "../router/router-context.js";
import { resolveSink, safeEmit } from "../router/telemetry.js";
import { contextSet } from "../context-var.js";
import {
  hasCachedManifest,
  getRouteTrie,
  getPrecomputedEntries,
  waitForManifestReady,
  getRouterManifest,
  getRouterTrie,
} from "../route-map-builder.js";
import type { HandlerContext } from "./handler-context.js";
import { buildRouterTrieFromUrlpatterns } from "./manifest-init.js";
import { handleProgressiveEnhancement } from "./progressive-enhancement.js";
import {
  executeServerAction,
  revalidateAfterAction,
  type ActionContinuation,
} from "./server-action.js";
import { handleLoaderFetch } from "./loader-fetch.js";
import { checkRequestOrigin, type OriginCheckPhase } from "./origin-guard.js";
import { handleRscRendering } from "./rsc-rendering.js";
import {
  withTimeout,
  RouterTimeoutError,
  createDefaultTimeoutResponse,
  type TimeoutPhase,
} from "../router/timeout.js";

/**
 * Create an RSC request handler.
 *
 * **Recommended:** Use `router.createHandler()` instead for simpler setup:
 * ```tsx
 * const router = createRouter({ document, urls, nonce: () => true });
 * export const fetch = router.createHandler();
 * ```
 *
 * This function is still useful for advanced cases like per-request cache
 * configuration (e.g., Cloudflare Workers with ExecutionContext).
 *
 * @example Basic usage (deps and loadSSRModule have sensible defaults)
 * ```tsx
 * import { createRSCHandler } from "@rangojs/router/rsc";
 * import { router } from "./router.js";
 *
 * export default createRSCHandler({ router });
 * ```
 *
 * @example With custom deps (advanced)
 * ```tsx
 * import { createRSCHandler } from "@rangojs/router/rsc";
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
export function createRSCHandler<
  TEnv = unknown,
  TRoutes extends Record<string, string> = Record<string, string>,
>(options: CreateRSCHandlerOptions<TEnv, TRoutes>) {
  const { router, version = VERSION, nonce: nonceProvider } = options;

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

  /**
   * Per-request error reporter that deduplicates via the ALS request context.
   *
   * Uses the same _reportedErrors WeakSet as the router layer so errors
   * that propagate across layers are only reported once per request.
   */
  function callOnError(
    error: unknown,
    phase: ErrorPhase,
    context: Parameters<typeof invokeOnError<TEnv>>[3],
  ): void {
    if (error != null && typeof error === "object") {
      const reportedErrors = requireRequestContext()._reportedErrors;
      if (reportedErrors.has(error)) return;
      reportedErrors.add(error);
    }
    invokeOnError(router.onError, error, phase, context, "RSC");
  }

  function getRequiredRouteMap(): Record<string, string> {
    const routeMap = getRouterManifest(router.id);
    if (!routeMap) {
      throw new Error(
        `Route manifest for router "${router.id}" is not available.`,
      );
    }
    return routeMap;
  }

  /**
   * Handle a timeout by reporting the error, emitting telemetry,
   * and returning either the custom onTimeout response or a default 504.
   */
  async function handleTimeoutResponse(
    request: Request,
    env: TEnv,
    url: URL,
    phase: TimeoutPhase,
    durationMs: number,
    routeKey?: string,
    actionId?: string,
  ): Promise<Response> {
    const timeoutError = new RouterTimeoutError(phase, durationMs);

    callOnError(timeoutError, phase === "action" ? "action" : "handler", {
      request,
      url,
      env,
      routeKey,
      actionId,
      handledByBoundary: false,
      metadata: { timeout: true, phase, durationMs },
    });

    try {
      const routerCtx = getRouterContext();
      if (routerCtx?.telemetry) {
        safeEmit(resolveSink(routerCtx.telemetry), {
          type: "request.timeout" as const,
          timestamp: performance.now(),
          requestId: routerCtx.requestId,
          phase,
          pathname: url.pathname,
          routeKey,
          actionId,
          durationMs,
          customHandler: !!router.onTimeout,
        });
      }
    } catch {
      // Router context may not be available
    }

    if (router.onTimeout) {
      try {
        return await router.onTimeout({
          phase,
          request,
          url,
          env,
          routeKey,
          actionId,
          durationMs,
        });
      } catch (e) {
        if (process.env.NODE_ENV !== "production") {
          console.error("[RSC] onTimeout callback error:", e);
        }
        return createDefaultTimeoutResponse(phase);
      }
    }

    return createDefaultTimeoutResponse(phase);
  }

  /**
   * Build a 200 Flight response that carries a redirect URL and optional state.
   * Used when a partial/action request results in a redirect -- fetch
   * auto-follows 3xx so we send the redirect as payload metadata instead.
   */
  function createRedirectFlightResponse(
    redirectUrl: string,
    locationState?: Record<string, unknown>,
  ): Response {
    const redirectPayload: RscPayload = {
      metadata: {
        pathname: redirectUrl,
        segments: [],
        redirect: { url: redirectUrl },
        ...(locationState && { locationState }),
      },
    };
    const rscStream = renderToReadableStream<RscPayload>(redirectPayload);
    return createResponseWithMergedHeaders(rscStream, {
      status: 200,
      headers: { "content-type": "text/x-component;charset=utf-8" },
    });
  }

  // Bundle shared dependencies for extracted handler functions.
  // callOnError reads from ALS so it's inherently per-request scoped.
  const handlerCtx: HandlerContext<TEnv> = {
    router,
    version,
    renderToReadableStream,
    decodeReply,
    createTemporaryReferenceSet,
    loadServerAction,
    decodeAction,
    decodeFormState,
    loadSSRModule,
    callOnError,
    getRequiredRouteMap,
    createRedirectFlightResponse,
    resolveStreamMode: async (request, env, url) => {
      const resolver = router.ssr?.resolveStreaming;
      if (!resolver) return "stream";
      return resolver({ request, env, url });
    },
  };

  return async function handler(
    request: Request,
    input: RouterRequestInput<TEnv> = {},
  ): Promise<Response> {
    const handlerStart = performance.now();

    const { env = {} as TEnv, vars: initialVars, ctx: executionCtx } = input;

    // Connection warmup: return 204 immediately before any processing
    if (router?.warmupEnabled && request.method === "HEAD") {
      const warmupUrl = new URL(request.url);
      if (warmupUrl.searchParams.has("_rsc_warmup")) {
        return new Response(null, { status: 204 });
      }
    }

    // Resolve nonce if provider is set
    const nonceStart = performance.now();
    let nonce: string | undefined;
    if (nonceProvider) {
      const result = await nonceProvider(request, env);
      nonce = result === true ? generateNonce() : result;
    }
    const nonceDur = performance.now() - nonceStart;

    const url = new URL(request.url);

    // Match global middleware
    const mwMatchStart = performance.now();
    const matchedMiddleware = matchMiddleware(url.pathname, router.middleware);
    const mwMatchDur = performance.now() - mwMatchStart;

    // Shared variables between middleware and route handlers
    // Initialize from input.vars if provided (allows pre-seeding from worker entry)
    const variables: Record<string, any> = initialVars
      ? { ...initialVars }
      : {};

    // Store nonce via ContextVar token and string key for backward compat
    if (nonce) {
      contextSet(variables, nonceToken, nonce);
      variables.nonce = nonce;
    }

    // Resolve cache store configuration
    // Priority: options.cache (handler override) > router.cache (router default)
    // Store is enabled only if: config provided, enabled, and no ?__no_cache query param
    let cacheStore = undefined;
    const cacheOption = options.cache ?? router.cache;
    if (cacheOption && !url.searchParams.has("__no_cache")) {
      const cacheConfig =
        typeof cacheOption === "function"
          ? cacheOption(env, executionCtx)
          : cacheOption;

      if (cacheConfig.enabled !== false) {
        cacheStore = cacheConfig.store;
      }
    }

    // Route manifest is populated at startup via the virtual module
    // (virtual:rsc-router/routes-manifest). In build/production, it's inlined
    // into the bundle. In dev mode (Node), the discovery plugin populates it
    // via setManifestReadyPromise(). In dev mode (Cloudflare), Miniflare runs
    // in a separate isolate where module-level state doesn't carry over, so
    // we generate inline from the router's urlpatterns.
    //
    // In multi-router setups (e.g. createHostRouter), each router must have
    // its own per-router manifest. We check per-router data first: even if
    // the global manifest was set by a different router, this router still
    // needs its own trie and manifest for correct matching.
    const manifestCacheStart = performance.now();
    const hasRouterData = getRouterManifest(router.id) !== undefined;
    if (!hasRouterData) {
      if (!hasCachedManifest()) {
        const readyPromise = waitForManifestReady();
        if (readyPromise) {
          await readyPromise;
        }
      }
      if (!getRouterManifest(router.id) && router.urlpatterns) {
        // Cloudflare dev: generate manifest inline for this router.
        // Each router generates its own manifest independently so
        // multi-router setups (host routing) work correctly.
        await buildRouterTrieFromUrlpatterns(router);
      }
      if (!getRouterManifest(router.id) && !hasCachedManifest()) {
        throw new Error(
          'Route manifest not available. Ensure "virtual:rsc-router/routes-manifest" is imported in your entry file.',
        );
      }
    }

    // Rebuild the trie when the manifest exists but the per-router trie is
    // missing. This happens in dev mode after HMR: the virtual module sets
    // the manifest (from fresh gen files) but the trie is intentionally not
    // injected to avoid stale discovery-time data. Without the trie, route
    // matching falls back to regex iteration which does not handle wildcard
    // priority correctly (catch-all patterns match before specific routes).
    if (!getRouterTrie(router.id) && router.urlpatterns) {
      await buildRouterTrieFromUrlpatterns(router);
    }
    const manifestCacheDur = performance.now() - manifestCacheStart;

    // Create unified request context with all methods
    // Includes: stub response, handle store, loader memoization, use(), cookies, headers, cache store
    // params starts empty, populated after route matching via setRequestContextParams
    const ctxCreateStart = performance.now();
    const requestContext = createRequestContext({
      env,
      request,
      url,
      variables,
      cacheStore,
      cacheProfiles: router.cacheProfiles,
      executionContext: executionCtx,
      themeConfig: router.themeConfig,
    });
    // Wire background error reporting so "use cache" and other subsystems
    // can surface non-fatal errors through the router's onError callback.
    requestContext._reportBackgroundError = (
      error: unknown,
      category: string,
    ) => {
      callOnError(error, "cache", {
        request,
        url,
        metadata: { category },
      });
    };

    const ctxCreateDur = performance.now() - ctxCreateStart;

    // Accumulate handler-level timing for Server-Timing header
    const handlerTiming = [
      `handler-nonce;dur=${nonceDur.toFixed(2)}`,
      `handler-mw-match;dur=${mwMatchDur.toFixed(2)}`,
      `handler-manifest-cache;dur=${manifestCacheDur.toFixed(2)}`,
      `handler-ctx-create;dur=${ctxCreateDur.toFixed(2)}`,
    ];

    // Store timing data in variables for downstream access
    variables.__handlerTiming = handlerTiming;
    variables.__handlerStart = handlerStart;

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
        const mwResponse = await executeMiddleware(
          matchedMiddleware,
          request,
          env,
          variables,
          coreHandler,
          createReverseFunction(getRequiredRouteMap()),
        );

        if (
          url.searchParams.has("_rsc_partial") ||
          url.searchParams.has("_rsc_action")
        ) {
          const intercepted = interceptRedirectForPartial(
            mwResponse,
            createRedirectFlightResponse,
          );
          if (intercepted) return intercepted;
        }

        return finalizeResponse(mwResponse);
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
    nonce: string | undefined,
  ): Promise<Response> {
    const previewStart = performance.now();
    const preview = await router.previewMatch(request, { env });
    const previewDur = performance.now() - previewStart;
    const handlerTiming: string[] = variables.__handlerTiming || [];
    handlerTiming.push(`handler-preview-match;dur=${previewDur.toFixed(2)}`);
    // Response route short-circuit: skip entire RSC pipeline
    if (preview?.responseType && preview.handler) {
      const responseOutcome = await withTimeout(
        handleResponseRoute(
          handlerCtx,
          preview as ResponseRouteMatch,
          request,
          env,
          url,
          variables,
        ),
        router.timeouts.renderStartMs,
        "render-start",
      );
      if (responseOutcome.timedOut) {
        return handleTimeoutResponse(
          request,
          env,
          url,
          "render-start",
          responseOutcome.durationMs,
          preview?.routeKey,
        );
      }
      return responseOutcome.result;
    }

    const routeReverse = createReverseFunction(getRequiredRouteMap());

    const isAction =
      request.headers.has("rsc-action") || url.searchParams.has("_rsc_action");
    const isLoaderFetch = url.searchParams.has("_rsc_loader");
    const actionId =
      request.headers.get("rsc-action") || url.searchParams.get("_rsc_action");

    // Origin guard: reject cross-origin actions, loader fetches, and
    // PE form submissions before any execution. Regular page navigations
    // (GET without _rsc_loader/_rsc_action) are not affected.
    const originPhase: OriginCheckPhase | null = isAction
      ? "action"
      : isLoaderFetch
        ? "loader"
        : request.method === "POST"
          ? "pe-form"
          : null;
    if (originPhase) {
      const originResult = await checkRequestOrigin(
        request,
        url,
        router.originCheck,
        env,
        router.id,
        originPhase,
      );
      if (originResult) {
        const originError = new Error(
          `Origin check rejected: ${request.headers.get("origin") ?? "none"} vs ${request.headers.get("host") ?? "none"}`,
        );
        originError.name = "OriginCheckError";

        callOnError(originError, "origin", {
          request,
          url,
          env,
          handledByBoundary: false,
          metadata: {
            phase: originPhase,
            origin: request.headers.get("origin"),
            host: request.headers.get("host"),
          },
        });

        try {
          const routerCtx = getRouterContext();
          if (routerCtx?.telemetry) {
            safeEmit(resolveSink(routerCtx.telemetry), {
              type: "request.origin-rejected" as const,
              timestamp: performance.now(),
              requestId: routerCtx.requestId,
              method: request.method,
              pathname: url.pathname,
              phase: originPhase,
              origin: request.headers.get("origin"),
              host: request.headers.get("host"),
            });
          }
        } catch {
          // Router context may not be available
        }

        return originResult;
      }
    }

    // Get handle store from request context
    const handleStore = requireRequestContext()._handleStore;

    // Wire up error reporting for late streaming-handle failures
    // (LateHandlePushError: handle pushed after stream completion).
    // Without this, these errors are only caught by React's error boundary
    // and never reach the router's onError callback or telemetry.
    handleStore.onError = (error: Error) => {
      const reqCtx = requireRequestContext();
      callOnError(error, "handler", {
        request,
        url,
        routeKey: reqCtx._routeName,
        params: reqCtx.params as Record<string, string>,
        handledByBoundary: true,
      });
      try {
        const routerCtx = getRouterContext();
        if (routerCtx?.telemetry) {
          safeEmit(resolveSink(routerCtx.telemetry), {
            type: "handler.error" as const,
            timestamp: performance.now(),
            requestId: routerCtx.requestId,
            error,
            handledByBoundary: true,
            pathname: url.pathname,
            routeKey: reqCtx._routeName,
            params: reqCtx.params as Record<string, string>,
          });
        }
      } catch {
        // Router context may not be available (e.g. prerender path)
      }
    };

    // Set route params early so all execution paths can access ctx.params.
    if (preview?.params) {
      setRequestContextParams(preview.params, preview.routeKey);
    }

    // Progressive enhancement runs before the normal action/render paths.
    // Route middleware wraps the PE re-render so handlers see the same
    // context variables regardless of JS/no-JS transport.
    const progressiveResult = await handleProgressiveEnhancement(
      handlerCtx,
      request,
      env,
      url,
      isAction,
      handleStore,
      nonce,
      {
        routeMiddleware: preview?.routeMiddleware,
        variables,
        routeReverse,
      },
    );
    if (progressiveResult) {
      return progressiveResult;
    }

    // --- Action execution: runs BEFORE route middleware ---
    // Route middleware wraps rendering only. For actions, the action runs
    // first in the global middleware context, then route middleware wraps
    // the revalidation pass (identical to a normal render).
    let actionContinuation: ActionContinuation | undefined;
    if (isAction && actionId) {
      try {
        const actionOutcome = await withTimeout(
          executeServerAction(
            handlerCtx,
            request,
            env,
            url,
            actionId,
            handleStore,
          ),
          router.timeouts.actionMs,
          "action",
        );
        if (actionOutcome.timedOut) {
          return handleTimeoutResponse(
            request,
            env,
            url,
            "action",
            actionOutcome.durationMs,
            preview?.routeKey,
            actionId,
          );
        }
        const result = actionOutcome.result;
        // Response means redirect or error boundary — done.
        if (result instanceof Response) return result;
        actionContinuation = result;
      } catch (error) {
        callOnError(error, "action", {
          request,
          url,
          env,
          actionId,
          handledByBoundary: false,
        });
        console.error(`[RSC] Action error:`, error);
        throw error;
      }
    }

    // --- Rendering (action revalidation or navigation) ---
    // Route middleware wraps this — same code path for both cases.
    const renderHandler = async () => {
      const response = await coreRequestHandlerInner(
        request,
        env,
        url,
        variables,
        nonce,
        preview?.params,
        preview?.routeKey,
        handleStore,
        actionContinuation,
      );
      if (preview?.negotiated) {
        response.headers.append("Vary", "Accept");
      }
      return response;
    };

    // Wrap the render path (with or without route middleware) in a
    // renderStartMs timeout so slow renders are caught before output.
    const executeRender = async (): Promise<Response> => {
      if (preview?.routeMiddleware && preview.routeMiddleware.length > 0) {
        const mwResponse = await executeMiddleware(
          buildRouteMiddlewareEntries<TEnv>(preview.routeMiddleware),
          request,
          env,
          variables,
          renderHandler,
          routeReverse,
        );

        if (
          url.searchParams.has("_rsc_partial") ||
          url.searchParams.has("_rsc_action")
        ) {
          const intercepted = interceptRedirectForPartial(
            mwResponse,
            createRedirectFlightResponse,
          );
          if (intercepted) return intercepted;
        }

        return finalizeResponse(mwResponse);
      }

      // No route middleware, proceed directly
      return renderHandler();
    };

    const renderOutcome = await withTimeout(
      executeRender(),
      router.timeouts.renderStartMs,
      "render-start",
    );
    if (renderOutcome.timedOut) {
      return handleTimeoutResponse(
        request,
        env,
        url,
        "render-start",
        renderOutcome.durationMs,
        preview?.routeKey,
      );
    }
    return renderOutcome.result;
  }

  // Inner request handler: rendering logic wrapped by route middleware.
  // Handles action revalidation (when actionContinuation is present),
  // loader fetches, and regular RSC rendering.
  async function coreRequestHandlerInner(
    request: Request,
    env: TEnv,
    url: URL,
    variables: Record<string, any>,
    nonce: string | undefined,
    routeParams?: Record<string, string>,
    routeKey?: string,
    handleStore?: ReturnType<typeof requireRequestContext>["_handleStore"],
    actionContinuation?: ActionContinuation,
  ): Promise<Response> {
    const isPartial = url.searchParams.has("_rsc_partial");
    const isAction =
      request.headers.has("rsc-action") || url.searchParams.has("_rsc_action");

    // Version mismatch detection - client may have stale code after HMR/deployment
    // If versions don't match, tell the client to reload
    const clientVersion = url.searchParams.get("_rsc_v");
    if (version && clientVersion && clientVersion !== version) {
      console.log(
        `[RSC] Version mismatch: client=${clientVersion}, server=${version}. Forcing reload.`,
      );

      // For actions, reload current page (referer) if same origin.
      // For navigation, load the target URL.
      // Validate referer origin to prevent open redirect via crafted header.
      let reloadUrl = stripInternalParams(url).toString();
      if (isAction) {
        const referer = request.headers.get("referer");
        if (referer) {
          try {
            const refererUrl = new URL(referer);
            if (refererUrl.origin === url.origin) {
              reloadUrl = referer;
            }
          } catch {
            // Malformed referer, fall back to cleanUrl
          }
        }
      }

      // Return special response that tells client to reload
      return createResponseWithMergedHeaders(null, {
        status: 200,
        headers: {
          "X-RSC-Reload": reloadUrl,
          "content-type": "text/x-component;charset=utf-8",
        },
      });
    }
    // Debug manifest endpoint: ?__debug_manifest on any route.
    // Always available in dev, requires allowDebugManifest option in production.
    const isDev = process.env.NODE_ENV !== "production";
    if (
      url.searchParams.has("__debug_manifest") &&
      (isDev || router.allowDebugManifest)
    ) {
      const trie = getRouterTrie(router.id) ?? getRouteTrie();
      const routeManifest = getRequiredRouteMap();
      const { extractAncestryFromTrie } =
        await import("../build/route-trie.js");
      return new Response(
        JSON.stringify(
          {
            routerId: router.id,
            routeManifest,
            routeAncestry: trie ? extractAncestryFromTrie(trie) : {},
            routeTrie: trie,
            precomputedEntries: getPrecomputedEntries(),
          },
          null,
          2,
        ),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const store = handleStore ?? requireRequestContext()._handleStore;

    try {
      // Route params were already set in coreRequestHandler, but set again
      // for callers that enter coreRequestHandlerInner directly.
      if (routeParams) {
        setRequestContextParams(routeParams, routeKey);
      }

      // ============================================================================
      // ACTION REVALIDATION (action already executed, revalidate segments)
      // ============================================================================
      if (actionContinuation) {
        return await revalidateAfterAction(
          handlerCtx,
          request,
          env,
          url,
          store,
          actionContinuation,
        );
      }

      // ============================================================================
      // LOADER FETCH EXECUTION (data fetching with RSC serialization)
      // ============================================================================
      const isLoaderRequest = url.searchParams.has("_rsc_loader");
      if (isLoaderRequest) {
        return handleLoaderFetch(
          handlerCtx,
          request,
          env,
          url,
          variables,
          routeParams,
        );
      }

      // ============================================================================
      // REGULAR RSC RENDERING (Navigation)
      // ============================================================================
      // Note: Must use "return await" for try/catch to catch async rejections
      return await handleRscRendering(
        handlerCtx,
        request,
        env,
        url,
        isPartial,
        store,
        nonce,
      );
    } catch (error) {
      // Check if middleware/handler returned Response
      if (error instanceof Response) {
        // During partial (client-side navigation), a 200 Response from a handler
        // means the route serves raw content (JSON, text, etc.), not JSX.
        // Signal the browser to hard-navigate so it renders the raw response.
        // Only for 200 — redirects (3xx) work already because the browser follows
        // them automatically to a URL that serves Flight data.
        if (isPartial && error.status === 200) {
          console.warn(
            `[RSC] Route handler at ${url.pathname} returned a Response during client-side navigation. ` +
              `Falling back to hard navigation. Use data-external on the <Link> to avoid the extra round-trip.`,
          );
          return createResponseWithMergedHeaders(null, {
            status: 200,
            headers: {
              "X-RSC-Reload": stripInternalParams(url).toString(),
              "content-type": "text/x-component;charset=utf-8",
            },
          });
        }

        if (isPartial) {
          const intercepted = interceptRedirectForPartial(
            error,
            createRedirectFlightResponse,
          );
          if (intercepted) return intercepted;
        }

        return error;
      }

      // Render 404 page for unmatched routes
      // Check both instanceof and error.name for cross-bundle compatibility
      const isRouteNotFound =
        error instanceof RouteNotFoundError ||
        (error instanceof Error && error.name === "RouteNotFoundError");
      if (isRouteNotFound) {
        callOnError(error, "routing", {
          request,
          url,
          env,
          handledByBoundary: true, // Handled by notFound component
        });

        // Get notFound component from router options or use default
        const notFoundOption = router.notFound;
        const notFoundComponent =
          typeof notFoundOption === "function"
            ? notFoundOption({ pathname: url.pathname })
            : (notFoundOption ?? createElement("h1", null, "Not Found"));

        // Create a simple segment for the 404 page
        const notFoundSegment = {
          id: "notFound",
          namespace: "notFound",
          type: "route" as const,
          index: 0,
          component: notFoundComponent,
          params: {},
        };

        const payload: RscPayload = {
          metadata: {
            pathname: url.pathname,
            segments: [notFoundSegment],
            matched: [],
            diff: [],
            isPartial: false,
            rootLayout: router.rootLayout,
            handles: store.stream(),
            version,
            themeConfig: router.themeConfig,
            warmupEnabled: router.warmupEnabled,
            initialTheme: requireRequestContext().theme,
            // No routeName for not-found routes
          },
        };

        const rscStream = renderToReadableStream(payload);

        // Determine if this is an RSC request or HTML request.
        // Partial requests are always RSC (see main isRscRequest comment).
        const isRscRequest =
          isPartial ||
          (!request.headers.get("accept")?.includes("text/html") &&
            !url.searchParams.has("__html")) ||
          url.searchParams.has("__rsc");

        if (isRscRequest) {
          return createResponseWithMergedHeaders(rscStream, {
            status: 404,
            headers: { "content-type": "text/x-component;charset=utf-8" },
          });
        }

        // Delegate to SSR for HTML response
        const [ssrModule, streamMode] = await Promise.all([
          loadSSRModule(),
          handlerCtx.resolveStreamMode(request, env, url),
        ]);
        const htmlStream = await ssrModule.renderHTML(rscStream, {
          nonce,
          streamMode,
        });

        return createResponseWithMergedHeaders(htmlStream, {
          status: 404,
          headers: { "content-type": "text/html;charset=utf-8" },
        });
      }

      // Report unhandled errors
      callOnError(error, "routing", {
        request,
        url,
        env,
        handledByBoundary: false,
      });
      console.error(`[RSC] Error:`, error);
      throw error;
    }
  }
}
