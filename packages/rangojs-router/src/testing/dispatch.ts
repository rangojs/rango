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
 *   - handler returning a Response:                     re-wrapped like
 *     handleResponseRoute (stub headers/cookies merged, Set-Cookie preserved,
 *     WebSocket upgrade passed through without reconstruction)
 *   - handler throwing an error:                        typed 500 / RouterError
 *     status, matching handleResponseRoute (RFC 9457 problem+json body with
 *     application/problem+json for json routes, text/plain message otherwise)
 *   - content-negotiated route:                         Vary: Accept appended
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
 *
 * What dispatch DOES NOT support (and why):
 * - RSC component routes — rendering requires the Flight serializer + React
 *   server runtime, which is the boundary this primitive is defined to avoid.
 *   This includes partial requests that resolve to a component route.
 * - Server actions (?_rsc_action) — RSC protocol concerns handled by
 *   router.fetch().
 * - ctx.onError() callbacks on a thrown response-route handler error: the
 *   error is serialized into the same typed 500 / RouterError Response as
 *   production, but registered onError handlers are NOT invoked here. Cover
 *   onError side effects with an e2e test.
 * - Location-state-carrying redirects on a partial/action request: production
 *   embeds a Flight payload (createRedirectFlightResponse) so the client can
 *   restore location state across the redirect. dispatch is RSC-free, so it
 *   cannot emit that Flight stream. It falls back to the no-state behavior — a
 *   204 + X-RSC-Redirect via createSimpleRedirectResponse — dropping the
 *   embedded location state. The 204 status, the X-RSC-Redirect header, and the
 *   merged cookies/headers all match production; only the Flight-embedded
 *   location-state entries are absent. Cover location-state restoration across a
 *   partial redirect with an e2e test.
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
import { setRouterManifest } from "../route-map-builder.js";
import { RESPONSE_TYPE_MIME } from "../router/content-negotiation.js";
import { RouterError } from "../errors.js";
import { createProblemDetails } from "../rsc/response-error.js";
import {
  createResponseWithMergedHeaders,
  createSimpleRedirectResponse,
  finalizeResponse,
  interceptRedirectForPartial,
  mergeStubHeadersAndFinalize,
} from "../rsc/helpers.js";
import { guardOutgoingRedirect } from "../rsc/redirect-guard.js";
import {
  EXTERNAL_REDIRECT_MARKER,
  isExternalRedirect,
  markExternalRedirect,
} from "../redirect-origin.js";
import { isWebSocketUpgradeResponse } from "../response-utils.js";
import type { Rango } from "../router/router-interfaces.js";

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
  findMatch(pathname: string): {
    redirectTo?: string;
    routeKey?: string;
    params?: Record<string, string>;
  } | null;
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
 * - "json" serializes the value verbatim (bare) with application/json,
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
    return new Response(JSON.stringify(result), {
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
 * Re-wrap a handler-returned Response, byte-identical to handleResponseRoute's
 * rewrapResponse:
 * - A WebSocket upgrade (status 101 or a `webSocket` property) is returned via
 *   mergeStubHeadersAndFinalize WITHOUT reconstruction — the Response
 *   constructor rejects status 101, and an upgrade response's headers/socket
 *   must not be rebuilt.
 * - Otherwise headers are copied into a fresh Headers (Set-Cookie appended to
 *   preserve duplicates, others set) and the Response is rebuilt through
 *   createResponseWithMergedHeaders so stub headers/cookies, the ctx.setStatus
 *   override, and onResponse callbacks merge exactly as in production. statusText
 *   is intentionally dropped (production does not carry it across the re-wrap).
 *
 * Must run inside runWithRequestContext (reads the ambient request context via
 * the helpers), which callHandler guarantees.
 */
function rewrapHandlerResponse(result: Response): Response {
  if (isWebSocketUpgradeResponse(result)) {
    return mergeStubHeadersAndFinalize(result);
  }
  const headers = new Headers();
  result.headers.forEach((value, key) => {
    // Mirror production: never copy the reserved external-redirect marker off a
    // handler result (it is not a trust signal; the opt-in is the out-of-band
    // brand transferred below).
    if (key.toLowerCase() === EXTERNAL_REDIRECT_MARKER) return;
    if (key.toLowerCase() === "set-cookie") {
      headers.append(key, value);
    } else {
      headers.set(key, value);
    }
  });
  const rewrapped = createResponseWithMergedHeaders(result.body, {
    status: result.status,
    headers,
  });
  // Mirror production's rewrapResponse: transfer the out-of-band external brand
  // only from a genuinely branded result (a real redirect(url, { external:
  // true })), never from a proxied upstream's forged header.
  if (isExternalRedirect(result)) {
    markExternalRedirect(rewrapped);
  }
  return rewrapped;
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
  const match = router.findMatch(url.pathname);
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
  // Match production: the RSC handler stores the router's basename on the
  // request context (handler.ts), and redirect() prefixes root-relative URLs
  // with it. Mirror it so basename-redirect tests behave as they do in a real
  // mounted app instead of always seeing no prefix.
  requestContext._basename = router.basename;

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
    const callResponseRoute = (): Promise<Response> => {
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
          const result = await (handler as Function)(responseHandlerCtx);
          if (result instanceof Response) {
            // Handler returned a Response: mirror handleResponseRoute's
            // rewrapResponse (WebSocket-upgrade bypass + Set-Cookie-preserving
            // header rebuild, statusText dropped) rather than the generic
            // createResponseWithMergedHeaders re-wrap below.
            merged = rewrapHandlerResponse(result);
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

    // coreHandler is the single terminal the global middleware chain wraps,
    // mirroring production's coreHandler (handler.ts): a trailing-slash/redirect
    // 308, an unmatched-path 404, or the response route. Both the 308 and the
    // 404 are produced via createResponseWithMergedHeaders so middleware-set
    // cookies/headers merge onto them, identical to production's
    // rsc-rendering.ts redirect path — and because they sit inside the chain, a
    // global middleware that short-circuits (e.g. an auth 401) runs first and
    // wins, never reaching the 308/404.
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
      return callResponseRoute();
    };

    // Global (pattern-matched) middleware wraps coreHandler, exactly as
    // production wraps coreHandler with executeMiddleware (handler.ts).
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
      const intercepted = interceptRedirectForPartial(
        mwResponse,
        (redirectUrl) => createSimpleRedirectResponse(redirectUrl),
      );
      finalResponse = finalizeResponse(intercepted ?? mwResponse);
    } else {
      finalResponse = finalizeResponse(mwResponse);
    }

    // Mirror production's single open-redirect chokepoint (handler.ts): every
    // browser-followed (3xx + Location) redirect is same-origin guarded before
    // it leaves -- a cross-origin Location is rewritten to the basename root
    // unless redirect(url, { external: true }) opted out. Soft partial/action
    // redirects are 204 + X-RSC-Redirect and pass through untouched (the client
    // validates them), so this is a no-op for them.
    return guardOutgoingRedirect(finalResponse, url.origin, router.basename);
  });
}
