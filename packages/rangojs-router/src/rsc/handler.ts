/// <reference types="@vitejs/plugin-rsc/types" />
/// <reference path="../vite/plugins/version.d.ts" />
/**
 * RSC Request Handler
 *
 * Main request handler for RSC rendering, server actions, loader fetching,
 * and progressive enhancement (no-JS form submissions).
 */

import { createElement } from "react";
import { isRouteNotFoundError } from "../errors.js";
import { matchMiddleware, executeMiddleware } from "../router/middleware.js";
import {
  runWithRequestContext,
  setRequestContextParams,
  requireRequestContext,
  getRequestContext,
  _getRequestContext,
  createRequestContext,
} from "../server/request-context.js";
import * as rscDeps from "@vitejs/plugin-rsc/rsc";
import type {
  RscPayload,
  CreateRSCHandlerOptions,
  LoadSSRModule,
  SSRModule,
} from "./types.js";
import {
  createResponseWithMergedHeaders,
  finalizeResponse,
  interceptRedirectForPartial,
  buildRouteMiddlewareEntries,
} from "./helpers.js";
import { isWebSocketUpgradeResponse } from "../response-utils.js";
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
import type { SegmentCacheStore } from "../cache/types.js";
import { buildRouterTrieFromUrlpatterns } from "./manifest-init.js";
import { handleProgressiveEnhancement } from "./progressive-enhancement.js";
import {
  executeServerAction,
  revalidateAfterAction,
  type ActionContinuation,
} from "./server-action.js";
import { handleLoaderFetch } from "./loader-fetch.js";
import {
  checkRequestOrigin,
  ORIGIN_CHECK_PHASE_BY_MODE,
} from "./origin-guard.js";
import { handleRscRendering } from "./rsc-rendering.js";
import {
  withTimeout,
  RouterTimeoutError,
  createDefaultTimeoutResponse,
  type TimeoutPhase,
} from "../router/timeout.js";
import {
  createMetricsStore,
  appendMetric,
  buildMetricsTiming,
} from "../router/metrics.js";
import {
  startSSRSetup,
  getSSRSetup,
  mayNeedSSR,
  isRscRequest,
  SSR_SETUP_VAR,
} from "./ssr-setup.js";
import {
  classifyRequest,
  type RequestPlan,
  type ExecutableRequestPlan,
} from "../router/request-classification.js";

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

/**
 * Response that tells the client to do a full document navigation. Shared by
 * the terminal reload plans (version-mismatch and app-switch): an empty 200
 * carrying X-RSC-Reload, which the client turns into window.location.href.
 */
function createReloadResponse(reloadUrl: string) {
  return createResponseWithMergedHeaders(null, {
    status: 200,
    headers: {
      "X-RSC-Reload": reloadUrl,
      "content-type": "text/x-component;charset=utf-8",
    },
  });
}

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

  // Use provided loadSSRModule or default to vite RSC module loader.
  // In production the SSR module is stable across requests, so memoize
  // the dynamic import to avoid repeated module resolution overhead.
  // In dev mode Vite may hot-reload the module, so skip memoization.
  const rawLoadSSRModule: LoadSSRModule =
    options.loadSSRModule ??
    (() => import.meta.viteRsc.loadModule("ssr", "index"));
  let _ssrModulePromise: Promise<SSRModule> | undefined;
  const loadSSRModule: LoadSSRModule =
    process.env.NODE_ENV === "production"
      ? () =>
          (_ssrModulePromise ??= rawLoadSSRModule().catch((err) => {
            _ssrModulePromise = undefined;
            throw err;
          }))
      : rawLoadSSRModule;

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
    // Guard: abort signal handlers fire asynchronously outside the ALS
    // request scope, so the context may be gone. Skip dedup in that
    // case — the error is from a cancelled stream, not a real failure.
    const reqCtx = _getRequestContext();
    if (error != null && typeof error === "object" && reqCtx) {
      if (reqCtx._reportedErrors.has(error)) return;
      reqCtx._reportedErrors.add(error);
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
    // Create the metrics store at handler start so handler:total has startTime=0
    // and all metrics are relative to the request entry point.
    const earlyMetricsStore = router.debugPerformance
      ? createMetricsStore(true, handlerStart)
      : undefined;

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
    let cacheStore: SegmentCacheStore | undefined;
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
    if (earlyMetricsStore) {
      requestContext._debugPerformance = true;
      requestContext._metricsStore = earlyMetricsStore;
    }
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
    // Store basename on request context (scoped per-request via existing ALS)
    requestContext._basename = router.basename;

    return runWithRequestContext(requestContext, async () => {
      // Core handler logic (wrapped by middleware)
      const coreHandler = async (): Promise<Response> => {
        return coreRequestHandler(request, env, url, variables, nonce);
      };

      // Execute middleware chain if any, otherwise call core handler directly
      let response: Response;
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
          response = intercepted ?? finalizeResponse(mwResponse);
        } else {
          response = finalizeResponse(mwResponse);
        }
      } else {
        response = await coreHandler();
      }

      // Finalize metrics after all middleware (including post-next work)
      // has completed so :post spans are captured in the timeline.
      // Handler timing parts are always emitted (even without debug metrics)
      // so non-debug requests still get bootstrap Server-Timing entries.
      const handlerTimingArr: string[] = variables.__handlerTiming || [];
      // Preserve any existing Server-Timing set by response routes or middleware
      const existingTiming = response.headers.get("Server-Timing");
      const timingParts = existingTiming
        ? [existingTiming, ...handlerTimingArr]
        : [...handlerTimingArr];

      const metricsStore = requestContext._metricsStore;
      if (metricsStore) {
        // When the store was created at handler start (earlyMetricsStore),
        // handler:total covers the full request. When ctx.debugPerformance()
        // created the store mid-request, use its requestStart to avoid a
        // negative startTime offset.
        const totalStart = earlyMetricsStore
          ? handlerStart
          : metricsStore.requestStart;
        appendMetric(
          metricsStore,
          "handler:total",
          totalStart,
          performance.now() - totalStart,
        );
        const metricsTiming = buildMetricsTiming(
          request.method,
          url.pathname,
          metricsStore,
        );
        if (metricsTiming) timingParts.push(metricsTiming);
      }

      const fullTiming = timingParts.join(", ");
      if (fullTiming && !isWebSocketUpgradeResponse(response)) {
        response.headers.set("Server-Timing", fullTiming);
      }

      return response;
    });
  };

  // Core request handling logic (separated for middleware wrapping).
  // Uses the classify → execute model: classifyRequest produces a RequestPlan,
  // then execution dispatches on the plan mode.
  async function coreRequestHandler(
    request: Request,
    env: TEnv,
    url: URL,
    variables: Record<string, any>,
    nonce: string | undefined,
  ): Promise<Response> {
    const handlerTiming: string[] = variables.__handlerTiming || [];

    // Debug manifest endpoint: handled before classification since it
    // doesn't need a route match and needs trie access from the closure.
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

    // ---- 1. Classify ----
    // classifyRequest may throw RouteNotFoundError for unknown routes.
    // In that case, fall through to a full-render plan so the pipeline
    // can render the 404 page via the existing error handling path.
    const classifyStart = performance.now();
    let plan: RequestPlan<TEnv>;
    try {
      plan = await classifyRequest<TEnv>(request, url, {
        findMatch: router.findMatch,
        routerVersion: version,
        routerId: router.id,
      });
    } catch (error) {
      if (isRouteNotFoundError(error)) {
        // Let the render path handle 404 — match()/matchPartial() will
        // re-throw RouteNotFoundError and the catch block in
        // executeRenderWithMiddleware renders the not-found page.
        plan = {
          mode: "full-render",
          route: {
            matched: null as any,
            manifestEntry: null as any,
            entries: [],
            routeKey: "",
            localRouteName: "",
            params: {},
            routeMiddleware: [],
            cacheScope: null,
            isPassthrough: false,
          },
          negotiated: false,
        };
      } else {
        throw error;
      }
    }
    const classifyDur = performance.now() - classifyStart;
    handlerTiming.push(`handler-classify;dur=${classifyDur.toFixed(2)}`);

    // ---- 2. Terminal plans (no execution needed) ----
    if (plan.mode === "redirect") {
      // Redirects are handled by the pipeline (match/matchPartial),
      // but for partial requests we short-circuit with a Flight redirect.
      if (url.searchParams.has("_rsc_partial")) {
        return createRedirectFlightResponse(plan.redirectUrl);
      }
      // Full requests: let the pipeline handle the redirect via match()
      // which returns { redirect: url }. Fall through to full-render.
    }

    if (plan.mode === "version-mismatch") {
      console.log(
        `[RSC] Version mismatch: client=${url.searchParams.get("_rsc_v")}, server=${version}. Forcing reload.`,
      );
      return createReloadResponse(plan.reloadUrl);
    }

    if (plan.mode === "app-switch") {
      // Cross-app SPA navigation crossed a host-router app boundary. Force a
      // real document navigation so the target app's document is re-established
      // (stylesheets, theme, warmup, prefetch-TTL). See request-classification.
      return createReloadResponse(plan.reloadUrl);
    }

    // ---- 3. Origin guard (gate for action/loader/PE modes) ----
    const originPhase = ORIGIN_CHECK_PHASE_BY_MODE[plan.mode];
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

    // ---- 4. Execute ----
    return executeRequest(
      plan as ExecutableRequestPlan<TEnv>,
      request,
      env,
      url,
      variables,
      nonce,
    );
  }

  // Execute a classified request plan. Dispatches to the appropriate handler
  // based on plan.mode. Lives in the createRSCHandler closure for access to
  // handlerCtx, router, callOnError, etc.
  // Only receives executable plans (version-mismatch is handled above).
  async function executeRequest(
    plan: ExecutableRequestPlan<TEnv>,
    request: Request,
    env: TEnv,
    url: URL,
    variables: Record<string, any>,
    nonce: string | undefined,
  ): Promise<Response> {
    // Common setup
    const handleStore = requireRequestContext()._handleStore;

    // Wire up error reporting for late streaming-handle failures
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
    // Also store the classified snapshot so match/matchPartial can reuse it
    // instead of calling resolveRoute again.
    if (plan.mode !== "redirect") {
      setRequestContextParams(plan.route.params, plan.route.routeKey);
      requireRequestContext()._classifiedRoute = plan.route;
    }

    const routeReverse = createReverseFunction(getRequiredRouteMap());

    // ---- Response route: skip entire RSC pipeline ----
    if (plan.mode === "response") {
      // Build ResponseRouteMatch from plan fields. handleResponseRoute
      // expects a flat object with params at the top level.
      const responseMatch: ResponseRouteMatch = {
        responseType: plan.responseType,
        handler: plan.handler,
        params: plan.route.params,
        negotiated: plan.negotiated,
        manifestEntry: plan.manifestEntry,
        routeMiddleware: plan.routeMiddleware,
      };
      const responseOutcome = await withTimeout(
        handleResponseRoute(
          handlerCtx,
          responseMatch,
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
          plan.route.routeKey,
        );
      }
      const response = responseOutcome.result;
      if (plan.negotiated && !isWebSocketUpgradeResponse(response)) {
        response.headers.append("Vary", "Accept");
      }
      return response;
    }

    // SSR setup: kick off in parallel for modes that need HTML rendering.
    // Placed after response-route short-circuit so response/mime routes
    // never pay for SSR work.
    if (plan.mode !== "loader" && mayNeedSSR(request, url)) {
      variables[SSR_SETUP_VAR] = startSSRSetup(
        handlerCtx,
        request,
        env,
        url,
        router.debugPerformance
          ? () => requireRequestContext()._metricsStore
          : undefined,
      );
    }

    // ---- Loader fetch ----
    if (plan.mode === "loader") {
      return handleLoaderFetch(
        handlerCtx,
        request,
        env,
        url,
        variables,
        plan.route.params,
      );
    }

    // ---- Progressive enhancement ----
    if (plan.mode === "pe-render") {
      const peResult = await handleProgressiveEnhancement(
        handlerCtx,
        request,
        env,
        url,
        false, // isAction = false for PE
        handleStore,
        nonce,
        {
          routeMiddleware: plan.route.routeMiddleware,
          variables,
          routeReverse,
        },
      );
      if (peResult) return peResult;
      // PE handler returned null (not a PE form) — fall through to render
    }

    // ---- Action: execute action, then revalidate wrapped in route middleware ----
    if (plan.mode === "action") {
      let actionContinuation: ActionContinuation | undefined;
      try {
        const actionOutcome = await withTimeout(
          executeServerAction(
            handlerCtx,
            request,
            env,
            url,
            plan.actionId,
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
            plan.route.routeKey,
            plan.actionId,
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
          actionId: plan.actionId,
          handledByBoundary: false,
        });
        console.error(`[RSC] Action error:`, error);
        throw error;
      }

      // Revalidation render wrapped in route middleware.
      // Actions from client-side navigation include _rsc_partial — preserve
      // the partial flag so the revalidation returns a Flight stream, not HTML.
      // App-switch is already excluded by classifyRequest (would be full-render).
      const isPartialAction = url.searchParams.has("_rsc_partial");
      return executeRenderWithMiddleware(
        plan.route.routeMiddleware,
        plan.negotiated,
        plan.route.routeKey,
        routeReverse,
        request,
        env,
        url,
        variables,
        nonce,
        handleStore,
        isPartialAction,
        actionContinuation,
      );
    }

    // Full render, partial render, fallen-through PE, and full-page redirect all
    // render through the same middleware-wrapped path. Only full/partial-render
    // carry negotiation + the partial flag; pe/redirect render plainly.
    const isPartial = plan.mode === "partial-render";
    const negotiated =
      plan.mode === "full-render" || plan.mode === "partial-render"
        ? plan.negotiated
        : false;
    return executeRenderWithMiddleware(
      plan.route.routeMiddleware,
      negotiated,
      plan.route.routeKey,
      routeReverse,
      request,
      env,
      url,
      variables,
      nonce,
      handleStore,
      isPartial,
    );
  }

  // Shared render execution: wraps handleRscRendering (or revalidateAfterAction)
  // in route middleware and timeout handling. Consolidates the pattern used by
  // action-revalidate, full-render, and partial-render modes.
  async function executeRenderWithMiddleware(
    routeMiddleware: import("../router/middleware-types.js").CollectedMiddleware[],
    negotiated: boolean,
    routeKey: string,
    routeReverse: ReturnType<typeof createReverseFunction>,
    request: Request,
    env: TEnv,
    url: URL,
    variables: Record<string, any>,
    nonce: string | undefined,
    handleStore: ReturnType<typeof requireRequestContext>["_handleStore"],
    isPartial: boolean,
    actionContinuation?: ActionContinuation,
  ): Promise<Response> {
    const renderHandler = async (): Promise<Response> => {
      try {
        let response: Response;
        if (actionContinuation) {
          response = await revalidateAfterAction(
            handlerCtx,
            request,
            env,
            url,
            handleStore,
            actionContinuation,
          );
        } else {
          response = await handleRscRendering(
            handlerCtx,
            request,
            env,
            url,
            isPartial,
            handleStore,
            nonce,
          );
        }
        if (negotiated && !isWebSocketUpgradeResponse(response)) {
          response.headers.append("Vary", "Accept");
        }
        return response;
      } catch (error) {
        // Check if middleware/handler returned Response
        if (error instanceof Response) {
          // During partial (client-side navigation), a 200 Response from a handler
          // means the route serves raw content (JSON, text, etc.), not JSX.
          // Signal the browser to hard-navigate so it renders the raw response.
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
        if (isRouteNotFoundError(error)) {
          callOnError(error, "routing", {
            request,
            url,
            env,
            handledByBoundary: true,
          });

          const notFoundOption = router.notFound;
          const notFoundComponent =
            typeof notFoundOption === "function"
              ? notFoundOption({ pathname: url.pathname })
              : (notFoundOption ?? createElement("h1", null, "Not Found"));

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
              routerId: router.id,
              basename: router.basename,
              segments: [notFoundSegment],
              matched: [],
              diff: [],
              isPartial: false,
              rootLayout: router.rootLayout,
              handles: handleStore.stream(),
              version,
              themeConfig: router.themeConfig,
              warmupEnabled: router.warmupEnabled,
              initialTheme: requireRequestContext().theme,
            },
          };

          const rscStream = renderToReadableStream(payload, {
            onError: (error: unknown) => {
              callOnError(error, "rendering", { request, url, env });
            },
          });

          if (isRscRequest(request, url, isPartial)) {
            return createResponseWithMergedHeaders(rscStream, {
              status: 404,
              headers: {
                "content-type": "text/x-component;charset=utf-8",
                // Router identity for the client's pre-decode integrity check; a
                // same-app 404 matches and applies in place. See response-adapter.
                "X-RSC-Router-Id": router.id,
              },
            });
          }

          const [ssrModule, streamMode] = await getSSRSetup(
            handlerCtx,
            request,
            env,
            url,
            requireRequestContext()._metricsStore,
          );
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
    };

    // Wrap the render path in a renderStartMs timeout
    const executeRender = async (): Promise<Response> => {
      if (routeMiddleware.length > 0) {
        const mwResponse = await executeMiddleware(
          buildRouteMiddlewareEntries<TEnv>(routeMiddleware),
          request,
          env,
          variables,
          renderHandler,
          routeReverse,
        );

        if (isPartial || actionContinuation) {
          const intercepted = interceptRedirectForPartial(
            mwResponse,
            createRedirectFlightResponse,
          );
          if (intercepted) return intercepted;
        }

        return finalizeResponse(mwResponse);
      }

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
        routeKey,
      );
    }
    return renderOutcome.result;
  }
}
