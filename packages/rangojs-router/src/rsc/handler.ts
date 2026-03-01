/// <reference types="@vitejs/plugin-rsc/types" />
/// <reference path="../vite/plugins/version.d.ts" />
/**
 * RSC Request Handler
 *
 * Main request handler for RSC rendering, server actions, loader fetching,
 * and progressive enhancement (no-JS form submissions).
 */

import { createElement } from "react";
import { RouteNotFoundError, RouterError } from "../errors.js";
import { matchMiddleware, executeMiddleware } from "../router/middleware.js";
import {
  runWithRequestContext,
  setRequestContextParams,
  requireRequestContext,
  createRequestContext,
  getLocationState,
} from "../server/request-context.js";
import { resolveLocationStateEntries } from "../browser/react/location-state-shared.js";
import * as rscDeps from "@vitejs/plugin-rsc/rsc";

import type { RscPayload, CreateRSCHandlerOptions } from "./types.js";
import {
  createResponseWithMergedHeaders,
  createSimpleRedirectResponse,
} from "./helpers.js";
import { generateNonce, nonce as nonceToken } from "./nonce.js";
import { VERSION } from "@rangojs/router:version";
import type { ErrorPhase } from "../types.js";
import type { RouterRequestInput } from "../router/router-interfaces.js";
import { invokeOnError } from "../router/error-handling.js";
import { createReverseFunction } from "../router/handler-context.js";
import { contextGet, contextSet } from "../context-var.js";
import { NOCACHE_SYMBOL } from "../cache/taint.js";
import { traverseBack } from "../router/pattern-matching.js";
import { createCacheScope } from "../cache/cache-scope.js";
import {
  hasCachedManifest,
  getRouteTrie,
  getPrecomputedEntries,
  waitForManifestReady,
  getRouterManifest,
  getRouterTrie,
} from "../route-map-builder.js";
import type { HandlerContext } from "./handler-context.js";
import { createResponseErrorPayload } from "./response-error.js";
import { buildRouterTrieFromUrlpatterns } from "./manifest-init.js";
import { handleProgressiveEnhancement } from "./progressive-enhancement.js";
import { handleServerAction } from "./server-action.js";
import { handleLoaderFetch } from "./loader-fetch.js";
import { handleRscRendering } from "./rsc-rendering.js";

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
// Only cache successful responses. Non-200 statuses (errors, redirects) are
// not cached — notFound() produces 500 in response routes, and explicit
// non-200 Responses are rare enough that caching them would be surprising.
function isCacheableStatus(status: number): boolean {
  return status === 200;
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

  // Use provided loadSSRModule or default to vite RSC module loader
  const loadSSRModule =
    options.loadSSRModule ??
    (() => import.meta.viteRsc.loadModule("ssr", "index"));

  // Track errors already reported to onError to prevent double-reporting
  // when errors are caught by a phase-specific handler and re-thrown.
  const reportedErrors = new WeakSet<object>();

  /**
   * Wrapper for invokeOnError that binds the router's onError callback.
   * Uses the shared utility from router/error-handling.ts for consistent behavior.
   */
  function callOnError(
    error: unknown,
    phase: ErrorPhase,
    context: Parameters<typeof invokeOnError<TEnv>>[3],
  ): void {
    if (error != null && typeof error === "object") {
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

  // Bundle shared dependencies for extracted handler functions
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

    // Note: Route map for useHref() is loaded lazily via getGlobalRouteMap()
    // This allows it to include all routes from lazy includes after manifest loading

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
      executionContext: executionCtx,
      themeConfig: router.themeConfig,
    });
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

        // If global middleware returned a redirect during a partial (SPA)
        // request, intercept it. fetch auto-follows 3xx, so we must signal
        // the redirect via our own mechanism instead.
        // - With state: Flight payload (200) so location state survives.
        // - Without state: 204 + X-RSC-Redirect header (lightweight).
        const isPartial = url.searchParams.has("_rsc_partial");
        const redirectUrl = mwResponse.headers.get("Location");
        const isRedirect =
          mwResponse.status >= 300 && mwResponse.status < 400 && redirectUrl;
        if (isPartial && isRedirect) {
          const locationState = getLocationState();
          if (locationState) {
            return createRedirectFlightResponse(
              redirectUrl,
              resolveLocationStateEntries(locationState),
            );
          }
          return createSimpleRedirectResponse(redirectUrl);
        }

        return mwResponse;
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
    // First, check for route-level middleware
    const previewStart = performance.now();
    const preview = await router.previewMatch(request, { env });
    const previewDur = performance.now() - previewStart;
    const handlerTiming: string[] = variables.__handlerTiming || [];
    handlerTiming.push(`handler-preview-match;dur=${previewDur.toFixed(2)}`);
    // Response route short-circuit: skip entire RSC pipeline
    if (preview?.responseType && preview.handler) {
      const isPartial = url.searchParams.has("_rsc_partial");

      // Partial requests (client-side navigation) to response routes
      // get X-RSC-Reload to trigger hard navigation in the browser
      if (isPartial) {
        const cleanUrl = new URL(url);
        cleanUrl.searchParams.delete("_rsc_partial");
        cleanUrl.searchParams.delete("_rsc_segments");
        cleanUrl.searchParams.delete("_rsc_v");
        cleanUrl.searchParams.delete("_rsc_stale");
        cleanUrl.searchParams.delete("_rsc_action");
        cleanUrl.searchParams.delete("_rsc_prev");

        return createResponseWithMergedHeaders(null, {
          status: 200,
          headers: {
            "X-RSC-Reload": cleanUrl.toString(),
            "content-type": "text/x-component;charset=utf-8",
          },
        });
      }

      // Build lightweight context for response handler
      const reqCtx = requireRequestContext();
      const responseHandlerCtx = {
        request,
        params: preview.params || {},
        env,
        searchParams: url.searchParams,
        url,
        pathname: url.pathname,
        href: (name: string, hrefParams?: Record<string, string>) => {
          if (name.startsWith("/")) {
            if (!hrefParams) return name;
            return name.replace(/:([^/]+)/g, (_, key) => {
              const value = hrefParams[key];
              if (value === undefined)
                throw new Error(`Missing param "${key}" for path "${name}"`);
              return encodeURIComponent(value);
            });
          }
          return name;
        },
        get: ((keyOrVar: any) => contextGet(variables, keyOrVar)) as any,
        header: (name: string, value: string) => reqCtx.header(name, value),
        setCookie: (name: string, value: string, options?: any) =>
          reqCtx.setCookie(name, value, options),
        _responseType: preview.responseType,
      };
      // Brand with taint symbol so "use cache" detects it as request-scoped
      // and extracts route-identifying properties (params, pathname, _responseType)
      (responseHandlerCtx as any)[NOCACHE_SYMBOL] = true;

      // Call handler directly, wrapped by route middleware if present
      const callHandler = async () => {
        // JSON response routes: wrap in { data } / { error } envelope
        if (preview.responseType === "json") {
          const errorCtx = { request, url, env };
          try {
            const result = await (preview.handler as Function)(
              responseHandlerCtx,
            );
            if (result instanceof Response) {
              const mergedHeaders: Record<string, string> = {};
              result.headers.forEach((value, key) => {
                mergedHeaders[key] = value;
              });
              return createResponseWithMergedHeaders(result.body, {
                status: result.status,
                headers: mergedHeaders,
              });
            }
            return createResponseWithMergedHeaders(
              JSON.stringify({ data: result }),
              {
                status: 200,
                headers: { "content-type": "application/json;charset=utf-8" },
              },
            );
          } catch (error) {
            callOnError(error, "handler", errorCtx);
            const isDev = process.env.NODE_ENV !== "production";
            const status = error instanceof RouterError ? error.status : 500;
            return createResponseWithMergedHeaders(
              JSON.stringify({
                error: createResponseErrorPayload(error, isDev),
              }),
              {
                status,
                headers: { "content-type": "application/json;charset=utf-8" },
              },
            );
          }
        }

        // Non-JSON response routes: catch errors and return plain Response
        const errorCtx = { request, url, env };
        try {
          const result = await (preview.handler as Function)(
            responseHandlerCtx,
          );

          if (result instanceof Response) {
            // Handler returned a Response directly -- pass through
            const mergedHeaders: Record<string, string> = {};
            result.headers.forEach((value, key) => {
              mergedHeaders[key] = value;
            });
            return createResponseWithMergedHeaders(result.body, {
              status: result.status,
              headers: mergedHeaders,
            });
          }

          // Auto-wrap based on response type tag
          switch (preview.responseType) {
            case "text":
              return createResponseWithMergedHeaders(String(result), {
                status: 200,
                headers: { "content-type": "text/plain;charset=utf-8" },
              });
            case "html":
              return createResponseWithMergedHeaders(String(result), {
                status: 200,
                headers: { "content-type": "text/html;charset=utf-8" },
              });
            case "xml":
              return createResponseWithMergedHeaders(String(result), {
                status: 200,
                headers: { "content-type": "application/xml;charset=utf-8" },
              });
            case "md":
              return createResponseWithMergedHeaders(String(result), {
                status: 200,
                headers: { "content-type": "text/markdown;charset=utf-8" },
              });
            default:
              // image, stream, any -- must return Response
              throw new Error(
                `Response route handler for "${preview.responseType}" must return a Response object, got ${typeof result}`,
              );
          }
        } catch (error) {
          callOnError(error, "handler", errorCtx);
          const isDev = process.env.NODE_ENV !== "production";
          const status = error instanceof RouterError ? error.status : 500;
          const message =
            error instanceof RouterError
              ? error.message
              : isDev && error instanceof Error
                ? error.message
                : "Internal Server Error";
          return createResponseWithMergedHeaders(message, {
            status,
            headers: { "content-type": "text/plain;charset=utf-8" },
          });
        }
      };

      // Wrap callHandler to append Vary: Accept on content-negotiated responses
      const callHandlerWithVary = async () => {
        const response = await callHandler();
        if (preview.negotiated) {
          response.headers.append("Vary", "Accept");
        }
        return response;
      };

      // Wrap with response caching if cache() config is present
      const executeHandler = async () => {
        if (preview.routeMiddleware && preview.routeMiddleware.length > 0) {
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
          return executeMiddleware(
            middlewareEntries,
            request,
            env,
            variables,
            callHandlerWithVary,
            createReverseFunction(getRequiredRouteMap()),
          );
        }
        return callHandlerWithVary();
      };

      // Resolve cache config from entry tree (same pattern as match-api.ts)
      if (preview.manifestEntry) {
        const entries = [...traverseBack(preview.manifestEntry)];
        let cacheScope: ReturnType<typeof createCacheScope> = null;
        for (const entry of entries) {
          if (entry.cache) {
            cacheScope = createCacheScope(entry.cache, cacheScope);
          }
        }

        if (cacheScope?.enabled) {
          const store = cacheScope.getStore() ?? reqCtx._cacheStore;
          if (store?.getResponse && store?.putResponse) {
            // Build cache key with response:{type}: prefix to avoid collision
            // with segment keys and differentiate between response types
            let cacheKey = `response:${preview.responseType}:${url.pathname}`;
            if (store.keyGenerator) {
              try {
                cacheKey = await store.keyGenerator(reqCtx, cacheKey);
              } catch {
                // Fall back to default key on keyGenerator failure
              }
            }

            try {
              const cached = await store.getResponse(cacheKey);

              if (cached && isCacheableStatus(cached.response.status)) {
                if (!cached.shouldRevalidate) {
                  // Fresh hit
                  return cached.response;
                }

                // Stale hit (SWR) - return cached, revalidate in background
                reqCtx.waitUntil(async () => {
                  try {
                    const fresh = await executeHandler();
                    if (isCacheableStatus(fresh.status)) {
                      await store.putResponse!(
                        cacheKey,
                        fresh,
                        cacheScope!.ttl,
                        cacheScope!.swr,
                      );
                    }
                  } catch (error) {
                    console.error(
                      `[ResponseCache] Revalidation failed:`,
                      error,
                    );
                  }
                });

                return cached.response;
              }
            } catch (error) {
              console.error(`[ResponseCache] Cache lookup failed:`, error);
            }

            // Cache miss - execute handler and cache the result
            const response = await executeHandler();

            if (isCacheableStatus(response.status)) {
              reqCtx.waitUntil(async () => {
                try {
                  await store.putResponse!(
                    cacheKey,
                    response.clone(),
                    cacheScope!.ttl,
                    cacheScope!.swr,
                  );
                } catch (error) {
                  console.error(`[ResponseCache] Cache write failed:`, error);
                }
              });
            }

            return response;
          }
        }
      }

      return executeHandler();
    }

    // Wrap RSC handler to append Vary: Accept on content-negotiated routes
    const rscHandler = async () => {
      const response = await coreRequestHandlerInner(
        request,
        env,
        url,
        variables,
        nonce,
        preview?.params,
        preview?.routeKey,
      );
      if (preview?.negotiated) {
        response.headers.append("Vary", "Accept");
      }
      return response;
    };

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
      const mwResponse = await executeMiddleware(
        middlewareEntries,
        request,
        env,
        variables,
        rscHandler,
        createReverseFunction(getRequiredRouteMap()),
      );

      // If route middleware returned a redirect during a partial (SPA)
      // request, intercept it. fetch auto-follows 3xx, so we must signal
      // the redirect via our own mechanism instead.
      // - With state: Flight payload (200) so location state survives.
      // - Without state: 204 + X-RSC-Redirect header (lightweight).
      const isPartial = url.searchParams.has("_rsc_partial");
      const mwRedirectUrl = mwResponse.headers.get("Location");
      const isMwRedirect =
        mwResponse.status >= 300 && mwResponse.status < 400 && mwRedirectUrl;
      if (isPartial && isMwRedirect) {
        const locationState = getLocationState();
        if (locationState) {
          return createRedirectFlightResponse(
            mwRedirectUrl,
            resolveLocationStateEntries(locationState),
          );
        }
        return createSimpleRedirectResponse(mwRedirectUrl);
      }

      return mwResponse;
    }

    // No route middleware, proceed directly
    return rscHandler();
  }

  // Inner request handler (actual RSC logic, wrapped by route middleware if any)
  async function coreRequestHandlerInner(
    request: Request,
    env: TEnv,
    url: URL,
    variables: Record<string, any>,
    nonce: string | undefined,
    routeParams?: Record<string, string>,
    routeKey?: string,
  ): Promise<Response> {
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
        `[RSC] Version mismatch: client=${clientVersion}, server=${version}. Forcing reload.`,
      );

      // Clean URL by removing RSC params
      const cleanUrl = new URL(url);
      cleanUrl.searchParams.delete("_rsc_partial");
      cleanUrl.searchParams.delete("_rsc_segments");
      cleanUrl.searchParams.delete("_rsc_v");
      cleanUrl.searchParams.delete("_rsc_stale");
      cleanUrl.searchParams.delete("_rsc_action");
      cleanUrl.searchParams.delete("_rsc_prev");

      // For actions, reload current page (referer) if same origin.
      // For navigation, load the target URL.
      // Validate referer origin to prevent open redirect via crafted header.
      let reloadUrl = cleanUrl.toString();
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

    // Get handle store from request context (created at start of request)
    const handleStore = requireRequestContext()._handleStore;

    try {
      // Set route params early so all execution paths (progressive enhancement,
      // server actions, loader fetches) can access ctx.params via getRequestContext().
      // Previously this was only done for JS actions, leaving PE actions with empty params.
      if (routeParams) {
        setRequestContextParams(routeParams, routeKey);
      }

      // ============================================================================
      // PROGRESSIVE ENHANCEMENT: No-JS Form Submissions
      // ============================================================================
      const progressiveResult = await handleProgressiveEnhancement(
        handlerCtx,
        request,
        env,
        url,
        isAction,
        handleStore,
        nonce,
      );
      if (progressiveResult) {
        return progressiveResult;
      }

      // ============================================================================
      // SERVER ACTION EXECUTION (JavaScript-enabled client)
      // ============================================================================
      if (isAction && actionId) {
        try {
          return await handleServerAction(
            handlerCtx,
            request,
            env,
            url,
            actionId,
            handleStore,
          );
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
        handleStore,
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
          const cleanUrl = new URL(url);
          cleanUrl.searchParams.delete("_rsc_partial");
          cleanUrl.searchParams.delete("_rsc_segments");
          cleanUrl.searchParams.delete("_rsc_v");
          cleanUrl.searchParams.delete("_rsc_stale");
          cleanUrl.searchParams.delete("_rsc_action");
          cleanUrl.searchParams.delete("_rsc_prev");
          return createResponseWithMergedHeaders(null, {
            status: 200,
            headers: {
              "X-RSC-Reload": cleanUrl.toString(),
              "content-type": "text/x-component;charset=utf-8",
            },
          });
        }

        // For partial requests: intercept redirects. HTTP 3xx redirects are
        // auto-followed by fetch, which would hit the target URL without
        // _rsc_partial and render a full HTML page the client can't parse.
        // - With state: Flight payload (200) so location state survives.
        // - Without state: 204 + X-RSC-Redirect header (lightweight).
        const redirectUrl = error.headers.get("Location");
        const isRedirect =
          error.status >= 300 && error.status < 400 && redirectUrl;
        if (isPartial && isRedirect) {
          const locationState = getLocationState();
          if (locationState) {
            return createRedirectFlightResponse(
              redirectUrl,
              resolveLocationStateEntries(locationState),
            );
          }
          return createSimpleRedirectResponse(redirectUrl);
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
            handles: handleStore.stream(),
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
        const ssrModule = await loadSSRModule();
        const htmlStream = await ssrModule.renderHTML(rscStream, { nonce });

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
