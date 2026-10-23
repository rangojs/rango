/// <reference types="@vitejs/plugin-rsc/types" />
/**
 * RSC Request Handler
 *
 * Main request handler for RSC rendering, server actions, loader fetching,
 * and progressive enhancement (no-JS form submissions).
 */

import { isRouteNotFoundError } from "../errors.js";
import { matchMiddleware, executeMiddleware } from "../router/middleware.js";
import {
  runWithRequestContext,
  setRequestContextParams,
  getRequestContext,
  _getRequestContext,
  createRequestContext,
  captureRequestEntryContext,
} from "../server/request-context.js";
import { payloadLocation } from "./full-payload.js";
import * as rscDeps from "@vitejs/plugin-rsc/rsc/server";
import type {
  RscPayload,
  CreateRSCHandlerOptions,
  LoadSSRModule,
  SSRModule,
} from "./types.js";
import {
  actionRenderRequest,
  createReloadResponse,
  createResponseWithMergedHeaders,
  finalizeResponse,
  interceptRedirectForPartial,
  buildRouteMiddlewareEntries,
} from "./helpers.js";
import { renderRscFlightStage, renderRscResponse } from "./render-pipeline.js";
import {
  resolveSoftRedirectUrl,
  resolveExternalRedirect,
  safeSameOriginLanding,
} from "../redirect-origin.js";
import { resolvedHandleStream } from "../handles/deferred-resolution.js";
import {
  isWebSocketUpgradeResponse,
  appendVaryAccept,
  trySetHeader,
} from "../response-utils.js";
import { nonce as nonceToken, resolveProviderNonce } from "./nonce.js";
import {
  resolvePrerenderVersion,
  resolveRouterVersions,
} from "../server/build-version-table.js";
import type { RouterRequestInput } from "../router/router-interfaces.js";
import { resolveDefaultNotFound } from "../router/error-handling.js";
import {
  printServerError,
  wasServerErrorPrinted,
} from "../server/print-server-error.js";
import { createReverseFunction } from "../router/handler-context.js";
import { contextSet } from "../context-var.js";
import {
  hasCachedManifest,
  waitForManifestReady,
  getRouterManifest,
  getRouterTrie,
} from "../route-map-builder.js";
import type { HandlerContext } from "./handler-context.js";
import {
  compileSearchParamsFilter,
  type SearchParamsFilter,
} from "../cache/search-params-filter.js";
import type { SegmentCacheStore } from "../cache/types.js";
import { buildRouterTrieFromUrlpatterns } from "./manifest-init.js";
import { handleProgressiveEnhancement } from "./progressive-enhancement.js";
import {
  continuationForRewritePass,
  executeServerAction,
  revalidateAfterAction,
  type ActionContinuation,
} from "./server-action.js";
import { handleLoaderFetch, renderLoaderError } from "./loader-fetch.js";
import {
  checkRequestOrigin,
  ORIGIN_CHECK_PHASE_BY_MODE,
} from "./origin-guard.js";
import { handleRscRendering } from "./rsc-rendering.js";
import { withoutShellMissMarker } from "./shell-serve.js";
import { readWarmMark } from "../prerender/warm-request.js";
import { defaultSSRModuleLoaderForTests } from "./ssr-module-loader.js";
import { withTimeout, isTimeoutEnabled } from "../router/timeout.js";
import {
  createMetricsStore,
  appendMetric,
  buildMetricsTiming,
} from "../router/metrics.js";
import { observePhase, PHASES } from "../router/instrument.js";
import { safeEmit, resolveSink, getRequestId } from "../router/telemetry.js";
import {
  startSSRSetup,
  createSsrHtmlStage,
  mayNeedSSR,
  isRscRequest,
  SSR_SETUP_VAR,
  type SSRSetup,
} from "./ssr-setup.js";
import type { ExecutableRequestPlan } from "../router/request-classification.js";
import {
  classify,
  createErrorReporter,
  finalizeRequestResponse,
  originRejectedResponse,
  reportBackgroundErrors,
  responseRouteMatch,
  runRequestPasses,
  serveResponseRoute,
  terminalPlanResponse,
  timeoutResponse,
} from "./request-stages.js";

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
 * import * as rsc from "@vitejs/plugin-rsc/rsc/server";
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
  const { router, nonce: nonceProvider } = options;
  // The router's own pair from the build.
  const versions = resolveRouterVersions(router.id);
  // Everything the handler itself versions is tied to the HTML a tab holds:
  // payload metadata (what the browser echoes as `_rsc_v`), the reload check,
  // shell stamping and gating, the rango state value. The data version is only
  // a cache-key prefix, read by the stores from the request context.
  const version = versions.document;

  // Handler-owned registry of explicit per-scope stores from cache({ store }).
  // Lives in the closure so it is scoped per handler (multi-router deployments
  // get separate registries) and accumulates every explicit store this handler
  // resolves across requests. updateTag()/revalidateTag() iterate it to reach
  // stores not covered by the app-level ctx._cacheStore.
  const explicitTaggedStores = new Set<SegmentCacheStore>();

  // Use provided deps or default to @vitejs/plugin-rsc/rsc/server exports
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
    (() =>
      // The test seam (ssr-module-loader.ts). Gated on the build mode, not
      // NODE_ENV: the rsc Vitest project forces NODE_ENV=production, its mode
      // is "test", and a production build folds the whole branch away.
      ((import.meta as any).env?.MODE !== "production" &&
        defaultSSRModuleLoaderForTests()?.()) ||
      import.meta.viteRsc.loadModule("ssr", "index"));
  let _ssrModulePromise: Promise<SSRModule> | undefined;
  const loadSSRModule: LoadSSRModule =
    process.env.NODE_ENV === "production"
      ? () =>
          (_ssrModulePromise ??= rawLoadSSRModule().catch((err) => {
            _ssrModulePromise = undefined;
            throw err;
          }))
      : rawLoadSSRModule;

  const callOnError = createErrorReporter<TEnv>(router);

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
   * Build a 200 Flight response that carries a redirect URL and optional state.
   * Used when a partial/action request results in a redirect -- fetch
   * auto-follows 3xx so we send the redirect as payload metadata instead.
   *
   * The redirect URL is resolved with {@link resolveSoftRedirectUrl} against
   * the current request origin so an unsafe target never leaves as Flight
   * metadata (client validators remain defense-in-depth).
   */
  function createRedirectFlightResponse(
    redirectUrl: string,
    locationState?: Record<string, unknown>,
    external?: boolean,
  ): Response {
    const reqCtx = _getRequestContext<TEnv>();
    const requestOrigin =
      reqCtx?.url.origin ?? new URL("http://localhost").origin;
    // Resolve with the same policy as 3xx guardOutgoingRedirect. Keep
    // external:true only when the external scheme check passed; a neutralized
    // landing (javascript:/blocked) must not advertise external.
    let resolvedUrl: string;
    let resolvedExternal = false;
    if (external) {
      const ext = resolveExternalRedirect(redirectUrl, requestOrigin);
      if (ext !== null) {
        resolvedUrl = ext;
        resolvedExternal = true;
      } else {
        resolvedUrl = safeSameOriginLanding(router.basename);
      }
    } else {
      resolvedUrl = resolveSoftRedirectUrl(
        redirectUrl,
        requestOrigin,
        router.basename,
        false,
      );
    }
    const redirectPayload: RscPayload = {
      metadata: {
        pathname: resolvedUrl,
        segments: [],
        redirect: {
          url: resolvedUrl,
          ...(resolvedExternal && { external: true }),
        },
        ...(locationState && { locationState }),
      },
    };
    const rscStream = reqCtx
      ? renderRscFlightStage({
          ctx: { renderToReadableStream, callOnError },
          request: reqCtx.request,
          url: reqCtx.url,
          env: reqCtx.env,
          payload: redirectPayload,
          tracking: {
            mode: reqCtx.url.searchParams.has("_rsc_action")
              ? "action-revalidation"
              : "partial",
            routeKey: reqCtx._routeName,
          },
        }).stream
      : renderToReadableStream<RscPayload>(redirectPayload);
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
    devDiscoveryEpoch: router.__devDiscoveryEpoch,
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
    incomingRequest: Request,
    input: RouterRequestInput<TEnv> = {},
  ): Promise<Response> {
    const handlerStart = performance.now();
    // Before any router scope: see captureRequestEntryContext.
    const runAtRequestEntry = captureRequestEntryContext();
    // A degraded PPR HIT's reload carries the forced-MISS marker: keep only
    // the flag (set on the request context below) and drop the marker before
    // anything reads the request, so middleware, handlers, loaders, cache
    // keys and the SSR search seed see the URL the visitor asked for.
    const unmarkedRequest = withoutShellMissMarker(incomingRequest);
    const request = unmarkedRequest ?? incomingRequest;
    // A router.prerender() warm: the mark is the incoming Request object
    // itself (prerender/warm-request.ts), read before anything rebuilds it.
    const warm = readWarmMark(incomingRequest);
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

    // Resolve nonce if provider is set. false/"" normalize to undefined —
    // the per-request opt-out (resolveProviderNonce).
    const nonceStart = performance.now();
    let nonce: string | undefined;
    if (nonceProvider) {
      nonce = resolveProviderNonce(await nonceProvider(request, env));
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
    let searchParamsFilter: SearchParamsFilter | undefined;
    const cacheOption = options.cache ?? router.cache;
    if (cacheOption && !url.searchParams.has("__no_cache")) {
      // A warm writes to the store the trigger checked the scope of.
      const cacheConfig =
        warm?.cacheConfig ??
        (typeof cacheOption === "function"
          ? cacheOption(env, executionCtx)
          : cacheOption);

      if (cacheConfig.enabled !== false) {
        cacheStore = cacheConfig.store;
        searchParamsFilter = compileSearchParamsFilter(
          cacheConfig.searchParams,
        );
      }
    }

    // Resolve the writable prerender store (durable overlay) for the serve path.
    // Same factory-or-object shape as cache, resolved per request from env/ctx
    // (never memoized). The version resolves per request, as router.prerender()
    // resolves it per refresh, so both sides key off the same table state.
    let resolvedPrerender:
      | import("../prerender/on-demand.js").ResolvedPrerender<any>
      | undefined;
    const prerenderOption = router._prerenderConfig;
    if (prerenderOption) {
      const prerenderConfig =
        typeof prerenderOption === "function"
          ? prerenderOption(env, executionCtx)
          : prerenderOption;
      if (prerenderConfig?.store) {
        resolvedPrerender = {
          config: prerenderConfig,
          routerId: router.id,
          version: resolvePrerenderVersion(router.id),
        };
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
      prerender: resolvedPrerender,
      searchParamsFilter,
      explicitTaggedStores,
      cacheProfiles: router.cacheProfiles,
      executionContext: executionCtx,
      themeConfig: router.themeConfig,
      stateCookieName: router.resolvedStateCookieName,
      versions,
    });
    if (unmarkedRequest) requestContext._shellForcedMiss = true;
    requestContext._runAtRequestEntry = runAtRequestEntry;
    if (warm) {
      requestContext._prerenderWarm = warm;
      requestContext._renderErrors = warm.renderErrors;
    }
    // Gate on the SAME enabled-semantics withTimeout uses (isTimeoutEnabled):
    // a `renderStartMs: 0` / negative opt-out disables the timeout, so the
    // driver's cursor bookkeeping (which only the timeout reads) must be off too.
    requestContext._renderDiagnosticsEnabled = isTimeoutEnabled(
      router.timeouts.renderStartMs,
    );
    // Thread the true request entry timestamp onto the context so a metrics
    // store created MID-request (ctx.debugPerformance() / getMetricsStore) anchors
    // to the real start, not the opt-in moment — phases that began earlier then
    // report non-negative offsets. Set unconditionally: debug may be enabled later.
    requestContext._handlerStart = handlerStart;
    if (earlyMetricsStore) {
      requestContext._debugPerformance = true;
      requestContext._metricsStore = earlyMetricsStore;
    }
    reportBackgroundErrors(requestContext, request, url, callOnError);

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
    requestContext._routerId = router.id;

    // Resolved span tracing for this request (read at each traced phase).
    requestContext._tracing = router.tracing;

    // The "rango.request" span is opened inside the request context so the
    // Cloudflare runner can read executionContext.tracing, and so every nested
    // phase span (and the platform's automatic KV/D1/fetch spans) nests under
    // it. Construction-bound: the span ends when the Response is built, never
    // wrapping the streamed body. metric:false — handler:total is metered
    // directly below (a grand total incl. the pre-context bootstrap timings).
    // When tracing is off this is a direct pass-through.
    return runWithRequestContext(requestContext, () =>
      observePhase(PHASES.request, async (span) => {
        span.setAttribute("http.method", request.method);
        // The matched route template is not known until match() runs later, so
        // emit the concrete path as url.path (low-level), NOT http.route — the
        // latter is reserved for the low-cardinality template (OTel convention).
        span.setAttribute("url.path", url.pathname);

        // The global middleware passes (rsc/request-stages.ts). The response
        // is finalized below, inside the response span.
        const {
          response: downstream,
          rewrittenTo,
          hasMiddleware,
        } = await runRequestPasses({
          ctx: handlerCtx,
          reqCtx: requestContext,
          request,
          url,
          env,
          variables,
          firstPassMiddleware: matchedMiddleware,
          core: (passRequest, passUrl) =>
            coreRequestHandler(passRequest, env, passUrl, variables, nonce),
          onHop: (pass) => {
            span.setAttribute("rango.rewrite.target", pass.target.pathname);
            span.setAttribute("rango.rewrite.hops", pass.hops);
          },
          // A loader fetch answers with the error `load()` rejects with.
          refuse: (error) =>
            url.searchParams.has("_rsc_loader")
              ? renderLoaderError(
                  handlerCtx,
                  { message: (error as Error).message, name: "Error" },
                  500,
                  {
                    request,
                    url,
                    env,
                    loaderId: url.searchParams.get("_rsc_loader") ?? "",
                  },
                )
              : undefined,
        });

        // Final response construction + host handoff, wrapped in rango.response
        // — the explicit stream-handoff marker. The callback is synchronous, so
        // the span ends immediately before the handler returns the response to
        // the host; it never reads or wraps response.body. A downstream throw
        // skips it entirely (no response exists to hand off).
        return observePhase(PHASES.response, (responseSpan) => {
          // Header and cookie writes from here on (a streaming loader or
          // render) no longer reach the response.
          requestContext._responseSent = true;
          const finalResponse = finalizeRequestResponse(downstream, {
            ctx: handlerCtx,
            reqCtx: requestContext,
            request,
            url,
            env,
            hasMiddleware,
            rewrittenTo,
            beforeGuard: (response) => {
              // Finalize metrics after all middleware (including post-next
              // work) has completed so :post spans are captured in the
              // timeline. Handler timing parts are always emitted (even
              // without debug metrics) so non-debug requests still get
              // bootstrap Server-Timing entries.
              const handlerTimingArr: string[] =
                variables.__handlerTiming || [];
              // Preserve any existing Server-Timing set by response routes or
              // middleware
              const existingTiming = response.headers.get("Server-Timing");
              const timingParts = existingTiming
                ? [existingTiming, ...handlerTimingArr]
                : [...handlerTimingArr];

              const metricsStore = requestContext._metricsStore;
              if (metricsStore) {
                // When the store was created at handler start
                // (earlyMetricsStore), handler:total covers the full request.
                // When ctx.debugPerformance() created the store mid-request
                // its requestStart is now the threaded _handlerStart
                // (== handlerStart), so both branches yield the true request
                // entry; reading the store's own anchor keeps this correct
                // even if a store ever lands without the threading (falls
                // back to its start).
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
              if (fullTiming) {
                trySetHeader(response, "Server-Timing", fullTiming);
              }
            },
          });

          // Attributes describe the response actually handed to the host (after
          // unsafe-redirect replacement), low-cardinality only. body_kind checks
          // the websocket marker before the body getter so a workerd upgrade
          // Response is never poked; `.body` is a getter access, not a read of
          // the stream.
          responseSpan.setAttribute(
            "http.response.status_code",
            finalResponse.status,
          );
          responseSpan.setAttribute(
            "rango.response.mode",
            requestContext._requestMode ?? "middleware-short-circuit",
          );
          responseSpan.setAttribute(
            "rango.response.body_kind",
            isWebSocketUpgradeResponse(finalResponse)
              ? "websocket"
              : finalResponse.body === null
                ? "empty"
                : "stream",
          );
          return finalResponse;
        });
      }),
    );
  };

  // Core request handling logic (separated for middleware wrapping).
  // The request stages (rsc/request-stages.ts) classify the request into a
  // RequestPlan and answer its terminal plans; execution dispatches on the
  // plan mode.
  async function coreRequestHandler(
    request: Request,
    env: TEnv,
    url: URL,
    variables: Record<string, any>,
    nonce: string | undefined,
  ): Promise<Response> {
    const handlerTiming: string[] = variables.__handlerTiming || [];

    // ---- 1. Classify ----
    const classifyStart = performance.now();
    const plan = await classify(request, url, handlerCtx);
    const classifyDur = performance.now() - classifyStart;
    handlerTiming.push(`handler-classify;dur=${classifyDur.toFixed(2)}`);

    // Stash the classified mode for the rango.response span (rango.response.mode)
    // — the outer handler tail cannot see the plan. Stays unset when middleware
    // short-circuits before core execution runs (reported as
    // "middleware-short-circuit").
    getRequestContext()._requestMode = plan.mode;

    // ---- 2. Terminal plans (no execution needed) ----
    const terminal = terminalPlanResponse(plan, url, handlerCtx);
    if (terminal) return terminal;

    // ---- 3. Origin guard (gate for action/loader/PE modes) ----
    const originPhase = ORIGIN_CHECK_PHASE_BY_MODE[plan.mode];
    if (originPhase) {
      const rejection = await checkRequestOrigin(
        request,
        url,
        router.originCheck,
        env,
        router.id,
        originPhase,
      );
      if (rejection) {
        return originRejectedResponse(
          rejection,
          originPhase,
          request,
          env,
          url,
          handlerCtx,
        );
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
    const handleStore = getRequestContext()._handleStore;

    // Wire up error reporting for late streaming-handle failures
    handleStore.onError = (error: Error) => {
      const reqCtx = getRequestContext();
      callOnError(error, "handler", {
        request,
        url,
        routeKey: reqCtx._routeName,
        params: reqCtx.params as Record<string, string>,
        handledByBoundary: true,
      });
      if (router.telemetry) {
        safeEmit(resolveSink(router.telemetry), {
          type: "handler.error",
          timestamp: performance.now(),
          requestId: getRequestId(request),
          error,
          handledByBoundary: true,
          pathname: url.pathname,
          routeKey: reqCtx._routeName,
          params: reqCtx.params as Record<string, string>,
        });
      }
    };

    // Set route params early so all execution paths can access ctx.params.
    // Also store the classified snapshot so match/matchPartial can reuse it
    // instead of calling resolveRoute again.
    if (plan.mode !== "redirect") {
      setRequestContextParams(plan.route.params, plan.route.routeKey);
      getRequestContext()._classifiedRoute = plan.route;
    }

    const routeReverse = createReverseFunction(getRequiredRouteMap());

    // ---- Response route: skip entire RSC pipeline ----
    if (plan.mode === "response") {
      return serveResponseRoute(handlerCtx, {
        match: responseRouteMatch(plan),
        routeKey: plan.route.routeKey,
        request,
        url,
        env,
        variables,
      });
    }

    // SSR setup: kick off in parallel for modes that need HTML rendering.
    // Placed after response-route short-circuit so response/mime routes
    // never pay for SSR work.
    //
    // Only kick off when the request will actually render HTML, so the
    // eager loadSSRModule() + user resolveStreaming() are not started (and
    // never consumed) for a request that returns an RSC stream — that wasted
    // work also leaves an orphaned Promise.all that can reject (D7). PE form
    // submissions always render HTML (handleProgressiveEnhancement renders via
    // getSSRSetup regardless of Accept). For full/partial-render and action,
    // the render-time HTML decision is exactly !isRscRequest — mayNeedSSR is
    // the coarse transport pre-filter, isRscRequest adds the partial/__rsc
    // flags; both share the same Accept rule (acceptsFlightExplicitly in
    // ssr-setup.ts), so the Accept call cannot drift between them. Both must
    // pass.
    const willRenderHtml =
      plan.mode === "pe-render" ||
      (mayNeedSSR(request, url) &&
        !isRscRequest(request, url, plan.mode === "partial-render"));
    if (plan.mode !== "loader" && willRenderHtml) {
      // A rewritten pass keeps the SSR module the earlier pass started
      // loading; the stream mode is resolved for the request it renders.
      const earlier = variables[SSR_SETUP_VAR] as Promise<SSRSetup> | undefined;
      const ssrSetup = startSSRSetup(
        handlerCtx,
        request,
        env,
        url,
        router.debugPerformance
          ? () => getRequestContext()._metricsStore
          : undefined,
        earlier?.then(([ssrModule]) => ssrModule),
      );
      variables[SSR_SETUP_VAR] = ssrSetup;

      // A handler can short-circuit before HTML rendering consumes this promise
      // (for example, by returning a redirect). Workerd cancels untracked dynamic
      // imports at the request boundary; retaining that cancelled promise in the
      // production SSR module memo makes every later document request hang.
      // Extending the request lifetime lets the shared setup settle without
      // delaying the short-circuit response.
      getRequestContext().executionContext?.waitUntil(ssrSetup);
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
      const reqCtx = getRequestContext();
      const ran = reqCtx._actionRan;
      let actionContinuation: ActionContinuation;
      if (ran?.kind === "action") {
        // A rewrite pass after the action ran: never run it again.
        actionContinuation = await continuationForRewritePass(
          handlerCtx,
          request,
          env,
          ran.continuation,
        );
      } else {
        try {
          // Instrument the action execution as its own phase (action:<actionId> +
          // rango.action), so a POST shows the mutation time AND which action ran,
          // not just the downstream revalidation render. The action's own
          // loaders/fetches nest under rango.action.
          const actionOutcome = await withTimeout(
            observePhase(PHASES.action(plan.actionId), () =>
              executeServerAction(
                handlerCtx,
                request,
                env,
                url,
                plan.actionId,
                handleStore,
              ),
            ),
            router.timeouts.actionMs,
            "action",
          );
          if (actionOutcome.timedOut) {
            return timeoutResponse(
              handlerCtx,
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
          reqCtx._actionRan = { kind: "action", continuation: result };
        } catch (error) {
          callOnError(error, "action", {
            request,
            url,
            env,
            actionId: plan.actionId,
            handledByBoundary: false,
          });
          printServerError(
            error,
            {
              label: "Action error",
              name: plan.actionId,
              pathname: url.pathname,
            },
            reqCtx,
          );
          throw error;
        }
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
    handleStore: ReturnType<typeof getRequestContext>["_handleStore"],
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
          // handleRscRendering bakes `accept` into the RSC response's Vary list;
          // dedup so the negotiated append does not list accept twice.
          appendVaryAccept(response);
        }
        return response;
      } catch (error) {
        // Check if middleware/handler returned Response
        if (error instanceof Response) {
          // An action revalidation render is delivered to the client over the
          // same Flight-parsing path as a partial navigation, so a Response
          // thrown during it must be converted exactly like a partial one
          // (raw 200 -> hard-nav hint, 3xx -> Flight redirect). Without this,
          // the no-middleware path returns the raw Response (the with-middleware
          // path is already covered by the isPartial || actionContinuation
          // guard below).
          const treatAsPartial = isPartial || actionContinuation != null;

          // During partial (client-side navigation), a 200 Response from a handler
          // means the route serves raw content (JSON, text, etc.), not JSX.
          // Signal the browser to hard-navigate so it renders the raw response.
          if (treatAsPartial && error.status === 200) {
            console.warn(
              `[RSC] Route handler at ${url.pathname} returned a Response during client-side navigation. ` +
                `Falling back to hard navigation. Use data-external on the <Link> to avoid the extra round-trip.`,
            );
            return createReloadResponse(getRequestContext(), url);
          }

          if (treatAsPartial) {
            const intercepted = interceptRedirectForPartial(
              error,
              createRedirectFlightResponse,
              { requestOrigin: url.origin, basename: router.basename },
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

          // No boundary to consult: an unmatched route has no entry chain, so
          // this always lands on the router option or the shared default.
          const notFoundComponent = resolveDefaultNotFound(
            router.notFound,
            url.pathname,
          );

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
              ...payloadLocation(getRequestContext(), url),
              routerId: router.id,
              basename: router.basename,
              segments: [notFoundSegment],
              matched: [],
              diff: [],
              // Shape parity with buildFullPayload (rsc-rendering.ts): the 404
              // payload carries params/resolvedIds/prefetchCacheTTL the same way a
              // matched full render does. resolvedIds mirrors the rendered segment
              // list (the single notFound segment) like the error-boundary path
              // (match-api.ts) does for its boundary segment.
              resolvedIds: [notFoundSegment.id],
              params: {},
              isPartial: false,
              rootLayout: router.rootLayout,
              // Full (404) render: resolve deferred handle values server-side.
              handles: resolvedHandleStream(handleStore),
              version,
              prefetchCacheTTL: router.prefetchCacheTTL,
              prefetchCacheSize: router.prefetchCacheSize,
              prefetchConcurrency: router.prefetchConcurrency,
              defaultPrefetch: router.defaultPrefetch,
              stateCookieName: router.resolvedStateCookieName,
              themeConfig: router.themeConfig,
              warmupEnabled: router.warmupEnabled,
              strictMode: router.strictMode,
              // The visitor's theme, not payloadInitialTheme (full-payload.ts):
              // that picks the default when middleware opted the URL into the
              // document cache before next(), but a 404 is never stored or
              // captured (#978).
              initialTheme: getRequestContext()._readTheme(),
            },
          };

          const isNotFoundFlightResponse = isRscRequest(
            request,
            url,
            isPartial,
          );
          const notFoundStageTracking = {
            mode: isPartial ? ("partial" as const) : ("full" as const),
            routeKey,
          };
          return renderRscResponse(
            {
              ctx: handlerCtx,
              request,
              url,
              env,
              payload,
              // The 404 path historically records no rsc-serialize metric (it
              // used the standalone Flight constructor, whose gate was opt-in);
              // opt out explicitly since renderRscResponse defaults the gate on.
              recordSerializeMetric: false,
              init: isNotFoundFlightResponse
                ? {
                    status: 404,
                    headers: {
                      "content-type": "text/x-component;charset=utf-8",
                      // Router identity for the client's pre-decode integrity
                      // check; a same-app 404 applies in place.
                      "X-RSC-Router-Id": router.id,
                    },
                  }
                : {
                    status: 404,
                    headers: {
                      "content-type": "text/html;charset=utf-8",
                    },
                  },
              tracking: notFoundStageTracking,
            },
            isNotFoundFlightResponse
              ? undefined
              : {
                  html: createSsrHtmlStage({
                    ctx: handlerCtx,
                    request,
                    env,
                    url,
                    metricsStore: getRequestContext()._metricsStore,
                    render: { nonce },
                  }),
                },
          );
        }

        // Report unhandled errors. Skip one the request already printed or
        // recorded as done: a shell error renderHTML rethrew to the host (dev),
        // which the html stage (rsc/ssr-setup.ts) reported when it started in
        // the SSR render; a copy's original was reported where it started.
        const printedContext = _getRequestContext();
        if (!wasServerErrorPrinted(error, printedContext)) {
          callOnError(error, "routing", {
            request,
            url,
            env,
            handledByBoundary: false,
          });
          printServerError(
            error,
            { label: "Error", pathname: url.pathname },
            printedContext,
          );
        }
        throw error;
      }
    };

    // Wrap the render path in a renderStartMs timeout
    const executeRender = async (): Promise<Response> => {
      if (routeMiddleware.length > 0) {
        const mwResponse = await executeMiddleware(
          buildRouteMiddlewareEntries<TEnv>(routeMiddleware),
          actionContinuation ? actionRenderRequest(request) : request,
          env,
          variables,
          renderHandler,
          routeReverse,
        );

        if (isPartial || actionContinuation) {
          const intercepted = interceptRedirectForPartial(
            mwResponse,
            createRedirectFlightResponse,
            { requestOrigin: url.origin, basename: router.basename },
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
      return timeoutResponse(
        handlerCtx,
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
