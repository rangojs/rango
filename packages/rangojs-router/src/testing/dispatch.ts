/**
 * dispatch — in-process request -> Response for unit/integration tests,
 * WITHOUT the Flight RSC runtime.
 *
 * dispatch runs the router's real matching and the production handler's
 * request stages (rsc/request-stages.ts: the global middleware passes, the
 * response route and the response's finalization) so that redirects, 404s,
 * response routes (path.json / path.text / path.html / ...), and middleware
 * short-circuits behave exactly as in production. It deliberately
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
 * - Response routes (non-RSC), served by production's handleResponseRoute
 *   (rsc/response-route-handler.ts)                  -> serialized Response
 *   - json:           JSON.stringify(result) (bare value) with application/json
 *   - text/html/xml/md: String(result) with the mapped MIME type
 *   - handler returning or throwing a Response:         re-wrapped (stub
 *     headers/cookies merged, Set-Cookie preserved, WebSocket upgrade passed
 *     through without reconstruction)
 *   - handler throwing a non-Response error:            typed 500 / RouterError
 *     status (RFC 9457 problem+json body with application/problem+json for
 *     json routes, text/plain message otherwise)
 *   - content-negotiated route:                         Vary: Accept appended
 *   - cached response route (cache({...})):             getResponse/putResponse
 *     hit/SWR/tag write, resolved from the matched entry tree. The write is
 *     scheduled via ctx.waitUntil
 *     (a microtask without an executionContext), so a HIT-asserting test must
 *     flush microtasks between the seeding dispatch and the asserting one.
 * - Global middleware (router.use(...)) AND route-level middleware, with full
 *   next()/short-circuit/throw-Response/header+cookie-merge fidelity.
 * - Partial (client-navigation) requests to a RESPONSE route (?_rsc_partial):
 *   global middleware runs first (so an auth gate can still 401/redirect),
 *   then — if it passes through — an X-RSC-Reload is returned. Route-level
 *   middleware is skipped on a partial, exactly as production skips it.
 * - A global middleware redirect (3xx + Location) on a partial/action request
 *   (?_rsc_partial / ?_rsc_action), and a findMatch() redirect on a partial
 *   request: a 204 + X-RSC-Redirect, so fetch() does not auto-follow the 3xx —
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

import type { RequestStageContext } from "../rsc/request-stages.js";
import type { ResponseRouteMatch } from "../rsc/response-route-handler.js";
import {
  createRequestContext,
  runWithRequestContext,
  setRequestContextParams,
} from "../server/request-context.js";
import { resolveRouterVersions } from "../server/build-version-table.js";
import type {
  MiddlewareEntry,
  MiddlewareFn,
} from "../router/middleware-types.js";
import {
  compileSearchParamsFilter,
  type CacheSearchParams,
  type SearchParamsFilter,
} from "../cache/search-params-filter.js";
import type { SegmentCacheStore } from "../cache/types.js";
import type { CacheProfile } from "../cache/profile-registry.js";
import type { EntryData } from "../server/context.js";
import { ensureRouterTrie } from "../rsc/manifest-init.js";
import {
  createResponseWithMergedHeaders,
  createSimpleRedirectResponse,
} from "../rsc/helpers.js";
import type { OnErrorCallback } from "../types/error-types.js";
import type { Rango } from "../router/router-interfaces.js";
import { getRequestId, resolveSink, safeEmit } from "../router/telemetry.js";
import type { TelemetrySink } from "../router/telemetry.js";
import type { OnTimeoutCallback, ResolvedTimeouts } from "../router/timeout.js";
import { WIRE } from "../wire-params.js";

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
  /** The routes() patterns the dev trie is rebuilt from (rsc/manifest-init.ts). */
  urlpatterns?: unknown;
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
    | {
        enabled?: boolean;
        store?: SegmentCacheStore;
        searchParams?: CacheSearchParams;
      }
    | ((
        env: TEnv,
        executionContext: unknown,
      ) => {
        enabled?: boolean;
        store?: SegmentCacheStore;
        searchParams?: CacheSearchParams;
      });
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

/** What one pass of a dispatch matched (the visitor's URL, or a rewrite target). */
interface DispatchPass {
  redirectTo?: string;
  /** The response route; neither it nor redirectTo means no match. */
  route?: ResponseRouteMatch;
  params: Record<string, string>;
  routeKey?: string;
}

async function matchDispatchPass<TEnv>(
  router: DispatchableRouter<TEnv>,
  req: Request,
  env: TEnv,
): Promise<DispatchPass> {
  const url = new URL(req.url);
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
  // 308/404 outcomes, so it stays a pre-middleware guard.
  const responseType = preview?.responseType;
  const handler = preview?.handler;
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
  const params = preview?.params ?? match?.params ?? {};
  return {
    redirectTo,
    route:
      responseType && typeof handler === "function"
        ? {
            responseType,
            handler,
            params,
            negotiated: preview?.negotiated,
            manifestEntry: preview?.manifestEntry,
            routeMiddleware: preview?.routeMiddleware,
          }
        : undefined,
    params,
    routeKey: preview?.routeKey ?? match?.routeKey,
  };
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

  const routerId = router.id ?? router.routerId;
  await ensureRouterTrie(router);

  const stages = await loadRequestStages();
  // The store keys with the router's versions, resolved as the production
  // handler resolves them (rsc/handler.ts).
  const versions = resolveRouterVersions(routerId);
  const ctx: RequestStageContext<TEnv> = {
    router: {
      basename: router.basename,
      middleware: router.middleware,
      onError: router.onError,
      telemetry: router.telemetry,
      timeouts: router.timeouts,
      onTimeout: router.onTimeout,
    },
    callOnError: stages.createErrorReporter<TEnv>(router),
    // A response-route handler's own throw is serialized into the same typed
    // Response as production but not reported (module header).
    reportResponseRouteError: () => {},
    getRequiredRouteMap: () => router.routeMap as Record<string, string>,
    // No Flight runtime: the no-state 204 + X-RSC-Redirect, dropping any
    // location state (module header). `external` is forwarded so
    // redirect(url, { external: true }) keeps its off-host target.
    createRedirectFlightResponse: (redirectUrl, _locationState, external) =>
      createSimpleRedirectResponse(redirectUrl, {
        requestOrigin: url.origin,
        basename: router.basename,
        external,
      }),
  };

  // The visitor's URL is matched before any middleware runs, so an RSC route
  // fails here, before a middleware side effect. A rewrite target is matched
  // the same way, at the start of its pass (below).
  const firstPass = await matchDispatchPass(router, req, env);

  const variables: Record<string, unknown> = {};

  // Resolve the router's cache store the way the production handler does, so a
  // "use cache" inside a response-route handler reaches the request-scope
  // (NOCACHE) detection instead of bypassing on a missing store.
  let cacheStore: SegmentCacheStore | undefined;
  let searchParamsFilter: SearchParamsFilter | undefined;
  const cacheOption = router.cache;
  if (cacheOption && !url.searchParams.has("__no_cache")) {
    const cacheConfig =
      typeof cacheOption === "function"
        ? cacheOption(env, undefined)
        : cacheOption;
    if (cacheConfig.enabled !== false) {
      cacheStore = cacheConfig.store;
      searchParamsFilter = compileSearchParamsFilter(cacheConfig.searchParams);
    }
  }

  const requestContext = createRequestContext<TEnv>({
    env,
    request: req,
    url,
    variables,
    cacheStore,
    searchParamsFilter,
    cacheProfiles: router.cacheProfiles,
    versions,
  });
  // Cache degradation (reportCacheError -> _reportBackgroundError) reaches the
  // router's onError, as in the production handler.
  stages.reportBackgroundErrors(requestContext, req, url, ctx.callOnError);
  // Match production: the RSC handler stores the router's basename on the
  // request context (handler.ts), and redirect() prefixes root-relative URLs
  // with it. Mirror it so basename-redirect tests behave as they do in a real
  // mounted app instead of always seeing no prefix.
  requestContext._basename = router.basename;
  requestContext._routerId = routerId;

  const isPartial = url.searchParams.has(WIRE.partial);

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
      // The production handler's global middleware passes, response route
      // and finalization (rsc/request-stages.ts). Each pass is matched before
      // its global chain, and its params are set there so global middleware
      // sees ctx.params; on an unmatched path there are none.
      let pass = firstPass;
      const { response, rewrittenTo, hasMiddleware } =
        await stages.runRequestPasses({
          ctx,
          reqCtx: requestContext,
          request: req,
          url,
          env,
          variables,
          beforePass: async (passRequest, _passUrl, index) => {
            if (index > 0) {
              pass = await matchDispatchPass(router, passRequest, env);
            }
            if (pass.routeKey !== undefined) {
              setRequestContextParams(pass.params, pass.routeKey);
            } else {
              requestContext.params = pass.params;
            }
          },
          // The core the global chain wraps: a findMatch() redirect (a soft
          // redirect on a partial request, else a 308), the response route,
          // or a 404. The 308 and 404 go through
          // createResponseWithMergedHeaders, so middleware cookies/headers
          // merge onto them as production's render path merges them.
          core: async (passRequest, passUrl) => {
            if (pass.redirectTo) {
              const redirectUrl = pass.redirectTo + passUrl.search;
              return (
                stages.partialRedirectResponse(redirectUrl, passUrl, ctx) ??
                createResponseWithMergedHeaders(null, {
                  status: 308,
                  headers: { Location: redirectUrl },
                })
              );
            }
            if (pass.route) {
              return stages.serveResponseRoute(ctx, {
                match: pass.route,
                routeKey: pass.routeKey,
                request: passRequest,
                url: passUrl,
                env,
                variables,
                abandon: abandonTimedOut,
              });
            }
            return createResponseWithMergedHeaders("Not Found", {
              status: 404,
              headers: { "content-type": "text/plain;charset=utf-8" },
            });
          },
        });

      return stages.finalizeRequestResponse(response, {
        ctx,
        reqCtx: requestContext,
        request: req,
        url,
        env,
        hasMiddleware,
        rewrittenTo,
        // request.end closes the transaction. dispatch produces no RSC
        // segments and holds no match-cache state, so segmentCount/cacheHit
        // are 0/false — the same shape production emits for its own redirect
        // (segment-less) result. The response is built before request.end
        // (unlike match()/matchPartial()), so it carries the status.
        beforeGuard: (finalResponse) => {
          if (!sink) return;
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
            status: finalResponse.status,
          });
        },
      });
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

let requestStages:
  | Promise<typeof import("../rsc/request-stages.js")>
  | undefined;

/**
 * The request stages, loaded on the first dispatch so the testing barrel's
 * eager graph stays what a suite that never dispatches loads. Neither graph
 * loads @vitejs/plugin-rsc (__tests__/testing-module-graph.test.ts). Held
 * after the first load: a dynamic import per dispatch costs a module-runner
 * lookup.
 */
function loadRequestStages(): Promise<
  typeof import("../rsc/request-stages.js")
> {
  return (requestStages ??= import("../rsc/request-stages.js"));
}

/**
 * A timed-out response route's work keeps running. Swallow its rejection and
 * cancel its body so, under a test runner, the abandoned handler cannot leak
 * into the next test. The production handler leaves it running.
 */
function abandonTimedOut(work: Promise<Response>): void {
  void work
    .then(
      (orphan) => orphan.body?.cancel(),
      () => {},
    )
    .catch(() => {});
}
