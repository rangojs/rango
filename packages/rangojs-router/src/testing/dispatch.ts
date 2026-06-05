/**
 * dispatch — in-process request -> Response for unit/integration tests,
 * WITHOUT the Flight RSC runtime.
 *
 * dispatch runs the router's real matching and middleware execution so that
 * redirects, 404s, response routes (path.json / path.text / path.html / ...),
 * and middleware short-circuits behave exactly as in production. It deliberately
 * does NOT render React Server Components: there is no Flight stream, no SSR,
 * and no DOM. Hit an RSC (component) route and dispatch throws a clear error
 * directing you to renderServer()/renderToFlightString or an e2e test.
 *
 * What dispatch DOES support:
 * - Trailing-slash and other findMatch() redirects   -> 308 with Location
 * - Unmatched paths                                  -> 404 Response
 * - Response routes (non-RSC)                         -> serialized Response
 *   - json:           JSON.stringify({ data }) with application/json
 *   - text/html/xml/md: String(result) with the mapped MIME type
 *   - handler returning a Response:                     passed through
 *   - handler throwing an error:                        typed 500 / RouterError
 *     status, matching handleResponseRoute (JSON error envelope for json
 *     routes, text/plain message otherwise)
 *   - content-negotiated route:                         Vary: Accept appended
 * - Global middleware (router.use(...)) AND route-level middleware, with full
 *   next()/short-circuit/throw-Response/header+cookie-merge fidelity.
 *
 * What dispatch DOES NOT support (and why):
 * - RSC component routes — rendering requires the Flight serializer + React
 *   server runtime, which is the boundary this primitive is defined to avoid.
 * - Server actions and partial (client navigation) requests — those are RSC
 *   protocol concerns handled by router.fetch().
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
import { createResponseErrorPayload } from "../rsc/response-error.js";
import { createResponseWithMergedHeaders } from "../rsc/helpers.js";
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
  /** Environment bindings forwarded to matching and middleware. */
  env?: TEnv;
}

const DEFAULT_ORIGIN = "http://localhost/";

function toRequest(request: Request | string): Request {
  if (request instanceof Request) return request;
  return new Request(new URL(request, DEFAULT_ORIGIN));
}

/**
 * Serialize a response-route handler result, mirroring the router's
 * handleResponseRoute() contract:
 * - a returned Response is passed through unchanged,
 * - "json" wraps the value as JSON.stringify({ data }) with application/json,
 * - text/html/xml/md stringify with the mapped MIME type.
 */
function serializeResponseRouteResult(
  result: unknown,
  responseType: string,
): Response {
  if (result instanceof Response) return result;

  if (responseType === "json") {
    return new Response(JSON.stringify({ data: result }), {
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
 * - status is the RouterError.status, else 500,
 * - "json" routes return { error: <createResponseErrorPayload> } as JSON,
 * - all other types return a text/plain body (the RouterError message verbatim,
 *   the Error message in dev, else "Internal Server Error").
 *
 * Reuses the production createResponseErrorPayload so the JSON error envelope
 * is byte-identical rather than re-derived.
 */
function serializeResponseRouteError(
  error: unknown,
  responseType: string,
): Response {
  const isDev = process.env.NODE_ENV !== "production";
  const status = error instanceof RouterError ? error.status : 500;

  if (responseType === "json") {
    return new Response(
      JSON.stringify({ error: createResponseErrorPayload(error, isDev) }),
      {
        status,
        headers: { "content-type": "application/json;charset=utf-8" },
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
 * const res = await dispatch(router, "/api/health");
 * expect(res.status).toBe(200);
 * expect(await res.json()).toEqual({ data: { ok: true } });
 * ```
 */
export async function dispatch<TEnv = any>(
  publicRouter: Rango<TEnv, any>,
  request: Request | string,
  opts: DispatchOptions<TEnv> = {},
): Promise<Response> {
  // The public Rango type intentionally hides the matching internals; read them
  // through the dispatchable shape (present at runtime). Consumers pass their
  // real router with no cast.
  const router = publicRouter as unknown as DispatchableRouter<TEnv>;
  const req = toRequest(request);
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

  if (match?.redirectTo) {
    return new Response(null, {
      status: 308,
      headers: { Location: match.redirectTo + url.search },
    });
  }

  if (!match) {
    return new Response("Not Found", {
      status: 404,
      headers: { "content-type": "text/plain;charset=utf-8" },
    });
  }

  // previewMatch resolves responseType, the response-route handler, and the
  // route middleware from the matched entry tree (with content negotiation).
  const preview = await router.previewMatch(req, { env });

  // No preview (e.g. resolved to a redirect inside previewMatch) — fall back to
  // the findMatch result. A bare match with no responseType is an RSC route.
  const responseType = preview?.responseType;
  const handler = preview?.handler;
  const params = preview?.params ?? match.params ?? {};
  const routeKey = preview?.routeKey ?? match.routeKey;

  if (!responseType || typeof handler !== "function") {
    throw new Error(
      `dispatch() does not render RSC routes — the route matched at ` +
        `"${url.pathname}" is a React Server Component route, not a response ` +
        `route. Use renderServer()/renderToFlightString or an e2e test to ` +
        `exercise component rendering.`,
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

  return runWithRequestContext(requestContext, async () => {
    // Match production: a partial (client-navigation) request to a response
    // route is short-circuited to X-RSC-Reload BEFORE the handler runs
    // (response-route-handler.ts). dispatch must not invoke the handler for
    // these, or a test could assert data the real server never returns.
    if (url.searchParams.has("_rsc_partial")) {
      return createResponseWithMergedHeaders(null, {
        status: 200,
        headers: {
          "X-RSC-Reload": stripInternalParams(url).toString(),
          "content-type": "text/x-component;charset=utf-8",
        },
      });
    }

    if (routeKey !== undefined) {
      setRequestContextParams(params, routeKey);
    } else {
      requestContext.params = params;
    }

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
      let serialized: Response;
      try {
        const result = await (handler as Function)(responseHandlerCtx);
        serialized = serializeResponseRouteResult(result, responseType);
      } catch (error) {
        // Mirror handleResponseRoute's catch: a genuine handler error becomes
        // the router's typed 500 / RouterError-status Response (NOT a rejected
        // promise). Middleware short-circuit via thrown Response is handled by
        // executeMiddleware and never reaches here.
        serialized = serializeResponseRouteError(error, responseType);
      }

      // Route through the SAME production finalizer the RSC handler uses, so
      // ctx.onResponse() callbacks fire and stub headers/cookies + ctx.setStatus
      // merge identically to production (handleResponseRoute also goes through
      // createResponseWithMergedHeaders). Runs inside runWithRequestContext, so
      // _getRequestContext() resolves to this request's context.
      const merged = createResponseWithMergedHeaders(serialized.body, {
        status: serialized.status,
        statusText: serialized.statusText,
        headers: serialized.headers,
      });

      // Append Vary: Accept on content-negotiated responses, matching
      // handleResponseRoute's callHandlerWithVary. Skipped on WebSocket upgrade
      // responses (immutable headers, Vary meaningless for a 101).
      if (preview?.negotiated && !isWebSocketUpgradeResponse(merged)) {
        merged.headers.append("Vary", "Accept");
      }

      return merged;
    };

    // Combine global (pattern-matched) middleware with route middleware,
    // preserving the router's order: global runs before route-level.
    const globalMatches = matchMiddleware(url.pathname, router.middleware);
    const routeMiddlewareEntries = (preview?.routeMiddleware ?? []).map(
      (mw) => ({
        entry: {
          pattern: null,
          regex: null,
          paramNames: [],
          handler: mw.handler,
          mountPrefix: null,
        } as MiddlewareEntry<TEnv>,
        params: mw.params,
      }),
    );
    const allMiddleware = [...globalMatches, ...routeMiddlewareEntries];

    if (allMiddleware.length === 0) {
      return callHandler();
    }

    return executeMiddleware<TEnv>(
      allMiddleware,
      req,
      env,
      variables,
      callHandler,
      reverse,
    );
  });
}
