/**
 * dispatch — in-process request -> Response for unit/integration tests,
 * WITHOUT the Flight RSC runtime.
 *
 * dispatch runs the router's real matching and middleware execution so that
 * redirects, 404s, response routes (path.json / path.text / path.html / ...),
 * and middleware short-circuits behave exactly as in production. It deliberately
 * does NOT render React Server Components: there is no Flight stream, no SSR,
 * and no DOM. Hit an RSC (component) route and dispatch throws a clear error
 * directing you to renderToFlightString/renderServerTree/renderHandler or an e2e test.
 *
 * What dispatch DOES support:
 * - Trailing-slash and other findMatch() redirects   -> 308 with Location
 * - Unmatched paths                                  -> 404 Response
 *   Both the 308 and the 404 are produced INSIDE the global middleware chain
 *   (mirroring production, where coreHandler runs wrapped by executeMiddleware),
 *   so a global auth middleware can 401/redirect them and middleware-set
 *   cookies/headers merge onto the 308/404 the way createResponseWithMergedHeaders
 *   merges them in production.
 * - Response routes (non-RSC)                         -> serialized Response
 *   - json:           JSON.stringify(result) (bare value) with application/json
 *   - text/html/xml/md: String(result) with the mapped MIME type
 *   - handler returning or throwing a Response:         re-wrapped like
 *     handleResponseRoute (stub headers/cookies merged, Set-Cookie preserved,
 *     WebSocket upgrade passed through without reconstruction)
 *   - handler throwing a non-Response error:            typed 500 / RouterError
 *     status, matching handleResponseRoute (RFC 9457 problem+json body with
 *     application/problem+json for json routes, text/plain message otherwise)
 *   - content-negotiated route:                         Vary: Accept appended
 *   - cached response route (cache({...})):             getResponse/putResponse
 *     hit/SWR/tag write, resolved from the matched entry tree exactly as
 *     handleResponseRoute does. The write is scheduled via ctx.waitUntil
 *     (a microtask without an executionContext), so a HIT-asserting test must
 *     flush microtasks between the seeding dispatch and the asserting one.
 * - Global middleware (router.use(...)) AND route-level middleware, with full
 *   next()/short-circuit/throw-Response/header+cookie-merge fidelity.
 * - Partial (client-navigation) requests to a RESPONSE route (?_rsc_partial):
 *   global middleware runs first (so an auth gate can still 401/redirect),
 *   then — if it passes through — an X-RSC-Reload is returned. Route-level
 *   middleware is skipped on a partial, exactly as production skips it.
 * - A middleware redirect (3xx + Location) on a partial/action request
 *   (?_rsc_partial / ?_rsc_action): converted to a 204 + X-RSC-Redirect via the
 *   real interceptRedirectForPartial, so fetch() does not auto-follow the 3xx —
 *   identical to production's no-location-state path.
 * - The open-redirect guard (rsc/redirect-guard.ts) on full (browser-followed)
 *   redirects: a cross-origin Location is rewritten to the basename root unless
 *   redirect(url, { external: true }) opted out, mirroring production's single
 *   handler chokepoint. Soft partial/action redirects are 204 and pass through.
 * - createRouter({ onError }) for CACHE / background-error degradation. dispatch
 *   wires the request context's _reportBackgroundError to the router's onError the
 *   same way the production RSC handler does, so a cache-read/cache-write/
 *   stale-revalidation failure on a cached response route (a throwing route
 *   cache({ key })/cache({ tags }), or a custom store whose keyGenerator/
 *   getResponse/putResponse throws) fires onError with phase "cache" and
 *   metadata.category, while the request still degrades-to-miss exactly as before.
 *   (A thrown non-Response route HANDLER error is the one onError path NOT covered —
 *   see "DOES NOT support" below.)
 * - createRouter({ telemetry }) match-transaction lifecycle: request.start opens
 *   the transaction before the global middleware chain, request.end closes it
 *   after finalizeResponse (segmentCount 0 / cacheHit false — dispatch renders no
 *   RSC segments and holds no match-cache state), and a thrown non-Response error
 *   emits request.error with phase "routing". All three carry the same requestId
 *   (getRequestId). Emission is gated entirely on a configured sink; with none,
 *   dispatch does zero new work and stays byte-identical for existing callers.
 *   Lets a consumer unit-test their sink wiring in-process instead of only at e2e.
 * - Response-route `renderStartMs` timeouts and `onTimeout`: dispatch races the
 *   same terminal response work, reports the timeout through onError/telemetry,
 *   and invokes the configured callback. `context.render` is absent because this
 *   primitive deliberately does not run the Flight/HTML render driver.
 *
 * What dispatch DOES NOT support (and why):
 * - RSC component routes — rendering requires the Flight serializer + React
 *   server runtime, which is the boundary this primitive is defined to avoid.
 *   This includes partial requests that resolve to a component route.
 * - Server actions (?_rsc_action) — RSC protocol concerns handled by
 *   router.fetch().
 * - createRouter({ onError }) on a thrown non-Response route HANDLER error: the
 *   error is serialized into the same typed 500 / RouterError Response as
 *   production, but onError is NOT invoked for that path here. Cover handler-error
 *   onError side effects with an e2e test. (This is the unchanged boundary; cache
 *   and other background errors DO route through onError — see below.)
 * - Location-state-carrying redirects on a partial/action request: production
 *   embeds a Flight payload (createRedirectFlightResponse) so the client can
 *   restore location state across the redirect. dispatch is RSC-free, so it
 *   cannot emit that Flight stream. It falls back to the no-state behavior — a
 *   204 + X-RSC-Redirect via createSimpleRedirectResponse — dropping the
 *   embedded location state. The 204 status, the X-RSC-Redirect header, and the
 *   merged cookies/headers all match production; only the Flight-embedded
 *   location-state entries are absent. Cover location-state restoration across a
 *   partial redirect with an e2e test.
 * - Telemetry cache.decision / loader.* / handler.error events: these fire from
 *   the real match()/matchPartial() + RSC render + loader pipeline (match-
 *   handlers.ts, loader-resolution.ts, segment-resolution), none of which
 *   dispatch runs. Synthesizing them here would be faking (the events would not
 *   reflect a real cache lookup or loader run), so dispatch emits only the
 *   request.start/end/error lifecycle above; cover cache/loader telemetry with an
 *   e2e test driving a real RSC request.
 *
 * dispatch reuses router.previewMatch(), which itself runs content negotiation
 * and resolves route middleware from the matched entry tree, so dispatch's
 * route-middleware collection is exactly the router's, not a re-implementation.
 */

import {
  createRequestContext,
  runWithRequestContext,
  setRequestContextParams,
} from "../server/request-context.js";
import { executeMiddleware, matchMiddleware } from "../router/middleware.js";
import type {
  MiddlewareEntry,
  MiddlewareFn,
} from "../router/middleware-types.js";
import {
  createReverseFunction,
  stripInternalParams,
} from "../router/handler-context.js";
import { NOCACHE_SYMBOL } from "../cache/taint.js";
import type { SegmentCacheStore } from "../cache/types.js";
import type { CacheProfile } from "../cache/profile-registry.js";
// cache-scope is loaded LAZILY inside the response-route cache path (below):
// its module graph pulls @vitejs/plugin-rsc/rsc (via segment-codec), which the
// non-Vite unit-test runner cannot resolve. A static import here would drag that
// onto the whole testing barrel's eager graph and break every consumer suite
// that imports `@rangojs/router/testing` without mocking plugin-rsc.
import type { EntryData } from "../server/context.js";
import { setRouterManifest } from "../route-map-builder.js";
import { RESPONSE_TYPE_MIME } from "../router/content-negotiation.js";
import { RouterError } from "../errors.js";
import { createProblemDetails } from "../rsc/response-error.js";
import {
  createResponseWithMergedHeaders,
  createSimpleRedirectResponse,
  finalizeResponse,
  interceptRedirectForPartial,
  rewrapResponseRouteResponse,
} from "../rsc/helpers.js";
import { guardOutgoingRedirect } from "../rsc/redirect-guard.js";
import { stringifyJsonRouteResult } from "../rsc/json-route-result.js";
import { isWebSocketUpgradeResponse } from "../response-utils.js";
import { invokeOnError } from "../router/error-handling.js";
import type { OnErrorCallback } from "../types/error-types.js";
import type { Rango } from "../router/router-interfaces.js";
import { getRequestId, resolveSink, safeEmit } from "../router/telemetry.js";
import type { TelemetrySink } from "../router/telemetry.js";
import {
  RouterTimeoutError,
  createDefaultTimeoutResponse,
  withTimeout,
} from "../router/timeout.js";
import type { OnTimeoutCallback, ResolvedTimeouts } from "../router/timeout.js";

/**
 * The internal subset of the router surface dispatch depends on. The public
 * `Rango` router carries these members at runtime (they are declared on the
 * internal interface), so dispatch accepts a public `Rango` and reads them
 * through this shape — the consumer never needs a cast.
 */
interface DispatchableRouter<TEnv> {
  id?: string;
  routerId?: string;
  routeMap: Record<string, unknown>;
  middleware: MiddlewareEntry<TEnv>[];
  onError?: OnErrorCallback<TEnv>;
  /**
   * Optional telemetry sink from createRouter({ telemetry }) (RangoInternal
   * field). dispatch emits the match-transaction lifecycle events onto it so a
   * consumer can unit-test their sink wiring in-process; undefined keeps dispatch
   * byte-identical for every existing caller.
   */
  telemetry?: TelemetrySink;
  timeouts?: ResolvedTimeouts;
  onTimeout?: OnTimeoutCallback<TEnv>;
  findMatch(pathname: string): Promise<{
    redirectTo?: string;
    routeKey?: string;
    params?: Record<string, string>;
  } | null>;
  previewMatch(
    request: Request,
    input?: { env?: TEnv },
  ): Promise<{
    routeMiddleware?: Array<{
      handler: MiddlewareFn<TEnv>;
      params: Record<string, string>;
    }>;
    responseType?: string;
    handler?: Function;
    params?: Record<string, string>;
    routeKey?: string;
    negotiated?: boolean;
    manifestEntry?: EntryData;
  } | null>;
  basename?: string;
  cache?:
    | { enabled?: boolean; store?: SegmentCacheStore }
    | ((
        env: TEnv,
        executionContext: unknown,
      ) => { enabled?: boolean; store?: SegmentCacheStore });
  cacheProfiles?: Record<string, CacheProfile>;
}

/**
 * Options for dispatch.
 */
export interface DispatchOptions<TEnv = any> {
  /** The request to dispatch: a `Request`, or a URL string (absolute or path). */
  request: Request | string;
  /** Environment bindings forwarded to matching and middleware. */
  env?: TEnv;
}

const DEFAULT_ORIGIN = "http://localhost/";

function toRequest(request: Request | string): Request {
  if (request instanceof Request) return request;
  return new Request(new URL(request, DEFAULT_ORIGIN));
}

/**
 * Serialize a NON-Response response-route handler result, mirroring the
 * router's handleResponseRoute() contract:
 * - "json" serializes the value (bare) with application/json, rejecting a nested
 *   unresolved Promise via the shared stringifyJsonRouteResult guard,
 * - text/html/xml/md stringify with the mapped MIME type.
 *
 * A handler-returned Response is NOT routed here — callHandler re-wraps it via
 * rewrapHandlerResponse (mirroring handleResponseRoute's rewrapResponse) so the
 * WebSocket-upgrade bypass and Set-Cookie-preserving header merge match
 * production.
 */
function serializeResponseRouteResult(
  result: unknown,
  responseType: string,
): Response {
  if (responseType === "json") {
    // Serialize through the SAME guard production uses: a nested unresolved
    // Promise (forgotten await) throws RESPONSE_NOT_SERIALIZABLE here, caught by
    // callHandler's catch and mapped to the identical typed 500 production
    // returns -- so a dispatch json test fails exactly where production would,
    // instead of silently emitting {} and passing.
    return new Response(stringifyJsonRouteResult(result), {
      status: 200,
      headers: { "content-type": "application/json;charset=utf-8" },
    });
  }

  if (Object.hasOwn(RESPONSE_TYPE_MIME, responseType)) {
    return new Response(String(result), {
      status: 200,
      headers: {
        "content-type": `${RESPONSE_TYPE_MIME[responseType]};charset=utf-8`,
      },
    });
  }

  throw new Error(
    `dispatch(): response route handler for "${responseType}" must return a ` +
      `Response object, got ${typeof result}. Binary/streaming response types ` +
      `(image, stream, any) must return a Response explicitly.`,
  );
}

/**
 * Serialize a thrown handler error into the same typed Response the router's
 * handleResponseRoute() catch block produces:
 * - "json" routes return an RFC 9457 problem+json body (application/problem+json),
 * - all other types return a text/plain body (the RouterError message verbatim,
 *   the Error message in dev, else "Internal Server Error").
 *
 * `status` is the effective HTTP status resolved by the caller (RouterError.status
 * or 500, overridden by ctx.setStatus()); it governs both the HTTP status and the
 * problem body's `status`/`title` members. Reuses the production
 * createProblemDetails so the error body is byte-identical rather than re-derived.
 */
function serializeResponseRouteError(
  error: unknown,
  responseType: string,
  status: number,
): Response {
  const isDev = process.env.NODE_ENV !== "production";

  if (responseType === "json") {
    return new Response(
      JSON.stringify(createProblemDetails(error, status, isDev)),
      {
        status,
        headers: { "content-type": "application/problem+json;charset=utf-8" },
      },
    );
  }

  const message =
    error instanceof RouterError
      ? error.message
      : isDev && error instanceof Error
        ? error.message
        : "Internal Server Error";
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain;charset=utf-8" },
  });
}

/**
 * Run a request through the router in-process and return the Response.
 *
 * @example
 * ```ts
 * const router = createRouter<Env>({}).routes(urls(({ path }) => [
 *   path.json("/api/health", () => ({ ok: true }), { name: "health" }),
 * ]));
 *
 * const res = await dispatch(router, { request: "/api/health" });
 * expect(res.status).toBe(200);
 * expect(await res.json()).toEqual({ ok: true });
 * ```
 */
export async function dispatch<TEnv = any>(
  publicRouter: Rango<TEnv, any>,
  opts: DispatchOptions<TEnv>,
): Promise<Response> {
  // The public Rango type intentionally hides the matching internals; read them
  // through the dispatchable shape (present at runtime). Consumers pass their
  // real router with no cast.
  const router = publicRouter as unknown as DispatchableRouter<TEnv>;
  const req = toRequest(opts.request);
  const url = new URL(req.url);
  const env = (opts.env ?? {}) as TEnv;

  // Seed the per-router manifest so reverse() resolves during handler execution.
  const routerId = router.id ?? router.routerId;
  if (routerId) {
    setRouterManifest(routerId, router.routeMap as Record<string, string>);
  }

  // findMatch carries trailing-slash/redirect targets and null on no match.
  // previewMatch swallows redirects, so detect them here first.
  const match = await router.findMatch(url.pathname);
  const redirectTo = match?.redirectTo;
  const isUnmatched = !match;

  // previewMatch resolves responseType, the response-route handler, and the
  // route middleware from the matched entry tree (with content negotiation).
  // Skip it for a redirect/unmatched path — there is no response route to
  // resolve, and previewMatch would return null / a redirect marker anyway.
  const preview =
    redirectTo || isUnmatched ? null : await router.previewMatch(req, { env });

  // A bare match with no responseType is an RSC route. The RSC-route throw is a
  // hard boundary of this primitive (no Flight runtime), distinct from the
  // 308/404 outcomes below, so it stays a pre-middleware guard.
  const responseType = preview?.responseType;
  const handler = preview?.handler;
  const params = preview?.params ?? match?.params ?? {};
  const routeKey = preview?.routeKey ?? match?.routeKey;

  if (
    !redirectTo &&
    !isUnmatched &&
    (!responseType || typeof handler !== "function")
  ) {
    throw new Error(
      `dispatch() does not render RSC routes — the route matched at ` +
        `"${url.pathname}" is a React Server Component route, not a response ` +
        `route. Use renderHandler/renderServerTree/renderToFlightString or an ` +
        `e2e test to exercise component rendering.`,
    );
  }

  const variables: Record<string, unknown> = {};

  // Resolve the router's cache store the way the production handler does, so a
  // "use cache" inside a response-route handler reaches the request-scope
  // (NOCACHE) detection below instead of bypassing on a missing store.
  let cacheStore: SegmentCacheStore | undefined;
  const cacheOption = router.cache;
  if (cacheOption && !url.searchParams.has("__no_cache")) {
    const cacheConfig =
      typeof cacheOption === "function"
        ? cacheOption(env, undefined)
        : cacheOption;
    if (cacheConfig.enabled !== false) cacheStore = cacheConfig.store;
  }

  const requestContext = createRequestContext<TEnv>({
    env,
    request: req,
    url,
    variables,
    cacheStore,
    cacheProfiles: router.cacheProfiles,
  });
  // Wire background error reporting so cache degradation (reportCacheError ->
  // _reportBackgroundError) reaches the router's onError, mirroring the production
  // RSC handler (rsc/handler.ts). Without this, dispatch could not observe onError.
  requestContext._reportBackgroundError = (error, category) => {
    if (error != null && typeof error === "object") {
      if (requestContext._reportedErrors.has(error)) return;
      requestContext._reportedErrors.add(error);
    }
    invokeOnError(
      router.onError,
      error,
      "cache",
      { request: req, url, metadata: { category } },
      "RSC",
    );
  };
  // Match production: the RSC handler stores the router's basename on the
  // request context (handler.ts), and redirect() prefixes root-relative URLs
  // with it. Mirror it so basename-redirect tests behave as they do in a real
  // mounted app instead of always seeing no prefix.
  requestContext._basename = router.basename;
  requestContext._routerId = routerId;

  // Match production's response-route reverse EXACTLY: the real handler builds
  // it from the route map alone (response-route-handler.ts), with NO matched
  // routeKey or params. Passing routeKey/params here would auto-fill params from
  // the matched route, so ctx.reverse("name") could pass in a test while the
  // real handler throws for the missing param.
  const reverse = createReverseFunction(
    router.routeMap as Record<string, string>,
  ) as (
    name: string,
    p?: Record<string, string>,
    search?: Record<string, unknown>,
  ) => string;

  const isPartial = url.searchParams.has("_rsc_partial");
  const isAction = url.searchParams.has("_rsc_action");

  // Telemetry: mirror the router's match-transaction lifecycle onto the
  // configured sink so a consumer can unit-test createRouter({ telemetry })
  // wiring in-process (the dogfood gap the RSC-free dispatch left — see
  // tests/cloudflare-basic/test/cache-status.test.ts). Every emit is gated on
  // `sink` truthiness: with no sink configured dispatch does zero new work and
  // stays byte-identical for existing callers. Only request.start/end/error are
  // reachable here — cache.decision and loader.* originate in the real match()/
  // matchPartial() + RSC render pipeline dispatch deliberately does not run
  // (module header), so fabricating them would violate the no-fake rule.
  const sink = router.telemetry;
  const telemetryRequestId = sink ? getRequestId(req) : undefined;
  const telemetryStart = sink ? performance.now() : 0;

  return runWithRequestContext(requestContext, async () => {
    // Set params before middleware/handler run, so global middleware sees
    // ctx.params (production sets them during matching, before middleware).
    // On a redirect/unmatched path there are no route params.
    if (routeKey !== undefined) {
      setRequestContextParams(params, routeKey);
    } else {
      requestContext.params = params;
    }

    // The response-route handler (with its own route middleware) lives inside
    // coreHandler below, mirroring production where handleResponseRoute is
    // nested inside coreHandler. Built lazily so a redirect/404 path never
    // touches it.
    const callResponseRoute = async (): Promise<Response> => {
      // Match production: a partial (client-navigation) request to a response
      // route is short-circuited to X-RSC-Reload (handleResponseRoute), BEFORE
      // route-level middleware runs. Route-level middleware is skipped on a
      // partial, exactly as production skips it.
      const partialFinalHandler = async (): Promise<Response> =>
        createResponseWithMergedHeaders(null, {
          status: 200,
          headers: {
            "X-RSC-Reload": stripInternalParams(url).toString(),
            "content-type": "text/x-component;charset=utf-8",
          },
        });

      const cleanUrl = new URL(req.url);
      for (const key of [...cleanUrl.searchParams.keys()]) {
        if (key.startsWith("_rsc")) cleanUrl.searchParams.delete(key);
      }

      // Lightweight response-handler context mirroring handleResponseRoute.
      const responseHandlerCtx = {
        request: req,
        params,
        env,
        searchParams: cleanUrl.searchParams,
        url: cleanUrl,
        originalUrl: requestContext.originalUrl,
        pathname: url.pathname,
        reverse,
        get: requestContext.get,
        header: (name: string, value: string) =>
          requestContext.header(name, value),
        waitUntil: requestContext.waitUntil.bind(requestContext),
        executionContext: requestContext.executionContext,
        _responseType: responseType,
      };
      // Brand as request-scoped so a "use cache" inside a response-route handler
      // is detected as a request-scope violation here exactly as in production
      // (response-route-handler.ts brands the same shape).
      (responseHandlerCtx as Record<symbol, unknown>)[NOCACHE_SYMBOL] = true;

      const callHandler = async (): Promise<Response> => {
        let merged: Response;
        try {
          let result: unknown;
          try {
            result = await (handler as Function)(responseHandlerCtx);
          } catch (error) {
            if (!(error instanceof Response)) throw error;
            result = error;
          }
          if (result instanceof Response) {
            merged = rewrapResponseRouteResponse(result);
          } else {
            // Route the serialized (json/text/...) body through the SAME
            // production finalizer the RSC handler uses, so ctx.onResponse()
            // callbacks fire and stub headers/cookies + the ctx.setStatus
            // override merge identically to production. Runs inside
            // runWithRequestContext, so _getRequestContext() resolves here.
            const serialized = serializeResponseRouteResult(
              result,
              responseType as string,
            );
            merged = createResponseWithMergedHeaders(serialized.body, {
              status: serialized.status,
              headers: serialized.headers,
            });
          }
        } catch (error) {
          // Mirror handleResponseRoute's catch: a genuine handler error becomes
          // the router's typed 500 / RouterError-status Response (NOT a rejected
          // promise). Middleware short-circuit via thrown Response is handled by
          // executeMiddleware and never reaches here.
          const derivedStatus =
            error instanceof RouterError ? error.status : 500;
          // Resolve the effective status the way createResponseWithMergedHeaders
          // (below) will (ctx.res.status override) BEFORE building the problem
          // body, so the body's status/title match the actual HTTP status when a
          // handler called ctx.setStatus() before throwing — exactly as
          // handleResponseRoute resolves it.
          const status =
            requestContext.res.status !== 200
              ? requestContext.res.status
              : derivedStatus;
          const serialized = serializeResponseRouteError(
            error,
            responseType as string,
            status,
          );
          merged = createResponseWithMergedHeaders(serialized.body, {
            status: serialized.status,
            headers: serialized.headers,
          });
        }

        // Append Vary: Accept on content-negotiated responses, matching
        // handleResponseRoute's callHandlerWithVary. Skipped on WebSocket
        // upgrade responses (immutable headers, Vary meaningless for a 101).
        if (preview?.negotiated && !isWebSocketUpgradeResponse(merged)) {
          merged.headers.append("Vary", "Accept");
        }

        return merged;
      };

      // On a partial request the reload IS the terminal handler and route
      // middleware is skipped; otherwise the response-route handler is wrapped
      // by route-level middleware (production order: route middleware runs
      // inside handleResponseRoute, after the global chain).
      if (isPartial) {
        return partialFinalHandler();
      }

      // executeHandler = callHandler wrapped by route-level middleware, exactly
      // the unit the production response cache wraps (response-route-handler.ts).
      const executeHandler = (): Promise<Response> => {
        const routeMiddlewareEntries = (preview?.routeMiddleware ?? []).map(
          (mw) => ({
            entry: {
              pattern: null,
              regex: null,
              paramNames: [],
              handler: mw.handler,
            } as MiddlewareEntry<TEnv>,
            params: mw.params,
          }),
        );
        if (routeMiddlewareEntries.length === 0) {
          return callHandler();
        }
        return executeMiddleware<TEnv>(
          routeMiddlewareEntries,
          req,
          env,
          variables,
          callHandler,
          reverse,
        );
      };

      // Response-route cache path: resolved through the SAME shared serve leaf
      // (rsc/response-cache-serve.ts) production uses, so a cached
      // path.json/path.text route hits/SWRs/writes tags through dispatch exactly
      // as in production — and the two can never drift. Resolved from the matched
      // entry tree (preview.manifestEntry), which previewMatch surfaces for
      // response routes.
      const manifestEntry = preview?.manifestEntry;
      if (manifestEntry) {
        // Lazy so the testing barrel's eager graph stays plugin-rsc-free (see the
        // import note above): the leaf takes createCacheScope/resolveCacheTags as
        // INJECTED deps so it never imports plugin-rsc; we hand it the lazily
        // imported pair here, only once a response route actually matched.
        const cacheScopeMod = await import("../cache/cache-scope.js");
        const { serveResponseRouteWithCache } =
          await import("../rsc/response-cache-serve.js");
        // requestContext is RequestContext<TEnv>; the leaf is typed against the
        // default-env RequestContext (it reads only env-agnostic config).
        // Assignable in the router's own tsc but not when a consumer pins a
        // concrete Env — cast to the leaf's param type.
        const cached = await serveResponseRouteWithCache({
          reqCtx: requestContext as Parameters<
            typeof serveResponseRouteWithCache
          >[0]["reqCtx"],
          manifestEntry,
          responseType: responseType as string,
          url,
          executeHandler,
          deps: {
            createCacheScope: cacheScopeMod.createCacheScope,
            resolveCacheTags: cacheScopeMod.resolveCacheTags,
          },
        });
        if (cached !== undefined) return cached;
      }

      return executeHandler().then(finalizeResponse);
    };

    // The renderStartMs deadline wraps ONLY the response-route unit, mirroring
    // handler.ts:845 where withTimeout(handleResponseRoute(...)) runs INSIDE
    // coreRequestHandler — after the global middleware chain has already
    // entered. Wrapping the outer chain (as an earlier version did) counted
    // global middleware time toward the deadline, so a slow global auth
    // middleware could 504 a request production serves. On timeout the 504/
    // onTimeout Response is RETURNED from coreHandler so it flows back out
    // through the global chain and finalizeResponse, identical to production
    // (handler.ts:857 returns handleTimeoutResponse into the same next() path).
    const runResponseRoute = async (): Promise<Response> => {
      const responseWork = callResponseRoute();
      const renderOutcome = await withTimeout(
        responseWork,
        router.timeouts?.renderStartMs,
        "render-start",
      );
      if (!renderOutcome.timedOut) return renderOutcome.result;

      // The race's losing side keeps executing after the timeout wins; its
      // eventual Response is dropped. Swallow any rejection (no
      // unhandled-rejection surfacing) and cancel the orphaned body stream so,
      // under vitest, the abandoned handler cannot leak into the next test.
      // Production abandons it too (handler.ts:845); this is a runner-scoped
      // cleanup, not an observable-behavior change.
      void responseWork
        .then(
          (orphan) => orphan.body?.cancel(),
          () => {},
        )
        .catch(() => {});

      const durationMs = renderOutcome.durationMs;
      const timeoutError = new RouterTimeoutError("render-start", durationMs);
      // Field-for-field parity with handleTimeoutResponse's callOnError
      // (handler.ts:254): env is passed through (was previously dropped). render
      // is always absent — dispatch runs no Flight/HTML driver, so there is no
      // foreground cursor to snapshot.
      invokeOnError(
        router.onError,
        timeoutError,
        "handler",
        {
          request: req,
          url,
          env,
          routeKey,
          handledByBoundary: false,
          metadata: { timeout: true, phase: "render-start", durationMs },
        },
        "RSC",
      );
      if (sink) {
        safeEmit(resolveSink(sink), {
          type: "request.timeout",
          timestamp: performance.now(),
          requestId: telemetryRequestId,
          phase: "render-start",
          pathname: url.pathname,
          routeKey,
          durationMs,
          customHandler: router.onTimeout !== undefined,
        });
      }
      if (router.onTimeout) {
        try {
          return await router.onTimeout({
            phase: "render-start",
            request: req,
            url,
            env,
            routeKey,
            durationMs,
          });
        } catch (error) {
          if (process.env.NODE_ENV !== "production") {
            console.error("[dispatch] onTimeout callback error:", error);
          }
          return createDefaultTimeoutResponse("render-start");
        }
      }
      return createDefaultTimeoutResponse("render-start");
    };

    // coreHandler is the single terminal the global middleware chain wraps,
    // mirroring production's coreHandler (handler.ts): a trailing-slash/redirect
    // 308, an unmatched-path 404, or the response route. Both the 308 and the
    // 404 are produced via createResponseWithMergedHeaders so middleware-set
    // cookies/headers merge onto them, identical to production's
    // rsc-rendering.ts redirect path — and because they sit inside the chain, a
    // global middleware that short-circuits (e.g. an auth 401) runs first and
    // wins, never reaching the 308/404. The renderStartMs deadline lives inside
    // runResponseRoute (below the chain), never covering the 308/404 paths —
    // production only wraps the response-route plan (handler.ts:834-856).
    const coreHandler = async (): Promise<Response> => {
      if (redirectTo) {
        return createResponseWithMergedHeaders(null, {
          status: 308,
          headers: { Location: redirectTo + url.search },
        });
      }
      if (isUnmatched) {
        return createResponseWithMergedHeaders("Not Found", {
          status: 404,
          headers: { "content-type": "text/plain;charset=utf-8" },
        });
      }
      return runResponseRoute();
    };

    // request.start opens the match transaction, mirroring match-handlers.ts.
    // transaction is always "match" (dispatch has no matchPartial split);
    // isPartial carries the ?_rsc_partial signal the same way production does.
    if (sink) {
      safeEmit(resolveSink(sink), {
        type: "request.start",
        timestamp: telemetryStart,
        requestId: telemetryRequestId,
        method: req.method,
        pathname: url.pathname,
        transaction: "match",
        isPartial,
      });
    }

    try {
      // Global (pattern-matched) middleware wraps coreHandler, exactly as
      // production wraps coreHandler with executeMiddleware (handler.ts:568).
      // The renderStartMs deadline is deliberately NOT applied here — it wraps
      // only the response-route unit inside coreHandler (see runResponseRoute),
      // mirroring handler.ts:845 so global middleware time is never counted
      // toward the deadline.
      const globalMatches = matchMiddleware(url.pathname, router.middleware);
      const mwResponse =
        globalMatches.length === 0
          ? await coreHandler()
          : await executeMiddleware<TEnv>(
              globalMatches,
              req,
              env,
              variables,
              coreHandler,
              reverse,
            );

      // Match production's global-chain exit (handler.ts): on a partial/action
      // request a middleware 3xx redirect is converted to a Flight-safe response
      // so fetch() does not auto-follow it; every path then drains onResponse
      // callbacks via finalizeResponse. dispatch is RSC-free, so the
      // createRedirectFlightResponse stand-in falls back to the no-state
      // 204 + X-RSC-Redirect (see the location-state divergence in the header).
      let finalResponse: Response;
      if (isPartial || isAction) {
        const softOpts = {
          requestOrigin: url.origin,
          basename: router.basename,
        };
        // Pass `external` through: interceptRedirectForPartial forwards the
        // out-of-band brand as the third callback arg (helpers.ts). Dropping it
        // would neutralize redirect(url, { external: true }) to "/" in dispatch
        // while production preserves it via createRedirectFlightResponse.
        const intercepted = interceptRedirectForPartial(
          mwResponse,
          (redirectUrl, _locationState, external) =>
            createSimpleRedirectResponse(redirectUrl, {
              ...softOpts,
              external,
            }),
          softOpts,
        );
        finalResponse = finalizeResponse(intercepted ?? mwResponse);
      } else {
        finalResponse = finalizeResponse(mwResponse);
      }

      // request.end closes the transaction. dispatch produces no RSC segments and
      // holds no match-cache state, so segmentCount/cacheHit are 0/false — the
      // same shape production emits for its own redirect (segment-less) result.
      if (sink) {
        safeEmit(resolveSink(sink), {
          type: "request.end",
          timestamp: performance.now(),
          requestId: telemetryRequestId,
          method: req.method,
          pathname: url.pathname,
          transaction: "match",
          durationMs: performance.now() - telemetryStart,
          segmentCount: 0,
          cacheHit: false,
          // dispatch's final response IS built before request.end (unlike
          // match()/matchPartial(), whose Response is built after), so stamp its
          // status — the same field a thrown-Response short-circuit carries.
          status: finalResponse.status,
        });
      }

      // Mirror production's single open-redirect chokepoint (handler.ts): every
      // browser-followed (3xx + Location) redirect is same-origin guarded before
      // it leaves -- a cross-origin Location is rewritten to the basename root
      // unless redirect(url, { external: true }) opted out. Soft partial/action
      // redirects are already resolved at createSimpleRedirectResponse time.
      return guardOutgoingRedirect(finalResponse, url.origin, router.basename);
    } catch (error) {
      if (sink) {
        if (error instanceof Response) {
          // executeMiddleware absorbs a middleware-thrown Response and returns it
          // (middleware.ts:566), so a thrown Response never actually reaches this
          // level in dispatch. Defensive: if one ever does it is a completed
          // request from the consumer's seat (a short-circuit redirect), so mirror
          // plan 002 / match-handlers.ts and emit request.end, not request.error.
          safeEmit(resolveSink(sink), {
            type: "request.end",
            timestamp: performance.now(),
            requestId: telemetryRequestId,
            method: req.method,
            pathname: url.pathname,
            transaction: "match",
            durationMs: performance.now() - telemetryStart,
            segmentCount: 0,
            cacheHit: false,
            // Carry the short-circuit Response's status (parity with
            // match-handlers.ts's thrown-Response request.end).
            status: error.status,
          });
        } else {
          safeEmit(resolveSink(sink), {
            type: "request.error",
            timestamp: performance.now(),
            requestId: telemetryRequestId,
            method: req.method,
            pathname: url.pathname,
            transaction: "match",
            error: error instanceof Error ? error : new Error(String(error)),
            phase: "routing",
            durationMs: performance.now() - telemetryStart,
          });
        }
      }
      throw error;
    }
  });
}
