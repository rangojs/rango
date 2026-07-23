/**
 * RSC Handler Helpers
 *
 * Utility functions for RSC request handling.
 */

import {
  _getRequestContext,
  getLocationState,
  setRequestContextParams,
} from "../server/request-context.js";
import type { RequestContext } from "../server/request-context.js";
import { resolveLocationStateEntries } from "../browser/react/location-state-shared.js";
import {
  isRedirectResponse,
  isWebSocketUpgradeResponse,
} from "../response-utils.js";
import {
  EXTERNAL_REDIRECT_MARKER,
  isExternalRedirect,
  markExternalRedirect,
  resolveSoftRedirectUrl,
} from "../redirect-origin.js";
import type { MiddlewareEntry, MiddlewareFn } from "../router/middleware.js";
import { formatCacheSignalHeader } from "../router/telemetry.js";
import type { RscPayload } from "./types.js";
import type { HandlerContext } from "./handler-context.js";

/**
 * DEVELOPMENT/TEST ONLY. When the debug cache signal gate is on,
 * match/matchPartial populate ctx._cacheSignal. Emit it as the X-Rango-Cache
 * header. When the gate is off, ctx._cacheSignal is undefined and NOTHING is
 * attached — output is byte-identical to the default. Header mutation failures
 * are swallowed so immutable Response headers (e.g. protocol-switch) are safe.
 */
function applyCacheSignalHeader(target: Headers, ctx: RequestContext): void {
  const signal = ctx._cacheSignal;
  if (!signal || signal.length === 0) return;
  try {
    target.set("X-Rango-Cache", formatCacheSignalHeader(signal));
  } catch {
    // Headers immutable — skip.
  }
}

/**
 * Copy stub headers from the request context onto a target Headers instance:
 * append Set-Cookie entries, set everything else only if absent. Header
 * mutation failures are swallowed so the same logic works against Response
 * headers that may be immutable (e.g. Cloudflare protocol-switch responses).
 */
function applyStubHeaders(target: Headers, stub: Headers): void {
  stub.forEach((value, name) => {
    try {
      // The reserved external-redirect marker is internal and never a trust
      // signal; never copy a stub value (e.g. a stray ctx.header() call) onto a
      // browser-facing response. The opt-in is the out-of-band brand.
      if (name.toLowerCase() === EXTERNAL_REDIRECT_MARKER) return;
      if (name.toLowerCase() === "set-cookie") {
        target.append(name, value);
      } else if (!target.has(name)) {
        target.set(name, value);
      }
    } catch {
      // Headers immutable — skip.
    }
  });
}

/**
 * Drain ctx._onResponseCallbacks onto a response. Swapping the array before
 * iteration prevents re-entrant registrations from double-firing and matches
 * the contract that each callback runs at most once per request.
 *
 * Exported so the testing primitives' buildRunResponse can reuse the exact
 * production drain (swap-before-iterate + external-redirect brand preservation)
 * rather than maintain a hand-synced copy. This module is plugin-rsc-free on its
 * eager graph (dispatch.ts already statically imports from here in the same
 * testing barrel), so importing it adds nothing to the unit runner's graph.
 */
export function drainOnResponseCallbacks(
  ctx: RequestContext,
  response: Response,
): Response {
  const callbacks = ctx._onResponseCallbacks;
  if (callbacks.length === 0) return response;
  ctx._onResponseCallbacks = [];
  // An onResponse callback may return a NEW Response (e.g. to add a header),
  // which drops the out-of-band external-redirect brand (brand is keyed on
  // Response object identity). Preserve a redirect(url, { external: true })
  // opt-in across that rebuild so a callback can't silently neutralize the
  // off-host redirect at the guard chokepoint.
  return applyOnResponseCallbacks(callbacks, response);
}

/** Apply a saved callback batch while preserving an external-redirect brand. */
export function applyOnResponseCallbacks(
  callbacks: Array<(response: Response) => Response>,
  response: Response,
): Response {
  const wasExternal = isExternalRedirect(response);
  let result = response;
  for (const callback of callbacks) {
    result = callback(result) ?? result;
  }
  if (wasExternal && !isExternalRedirect(result)) {
    markExternalRedirect(result);
  }
  return result;
}

/**
 * Check if a request body has content to decode
 */
export function hasBodyContent(body: FormData | string): boolean {
  if (body instanceof FormData) {
    let hasContent = false;
    body.forEach(() => {
      hasContent = true;
    });
    return hasContent;
  }
  return typeof body === "string" && body.length > 0;
}

/**
 * Create a Response with headers merged from the request context's stub response.
 * This ensures headers/cookies set during middleware or handler execution are included.
 * Also triggers any registered onResponse callbacks.
 */
export function createResponseWithMergedHeaders(
  body: BodyInit | null,
  init: ResponseInit,
): Response {
  const ctx = _getRequestContext();
  if (!ctx) {
    return new Response(body, init);
  }

  // Delete Set-Cookie from the stub after consuming so downstream merge
  // points (e.g. executeMiddleware) don't duplicate them.
  const mergedHeaders = new Headers(init.headers);
  applyStubHeaders(mergedHeaders, ctx.res.headers);
  ctx.res.headers.delete("set-cookie");
  applyCacheSignalHeader(mergedHeaders, ctx);

  // ctx.res.status overrides init.status when explicitly set (e.g. 404 for
  // notFound, 500 for error). Default ctx.res.status is 200.
  const status = ctx.res.status !== 200 ? ctx.res.status : init.status;

  const response = new Response(body, {
    ...init,
    status,
    headers: mergedHeaders,
  });

  return drainOnResponseCallbacks(ctx, response);
}

/**
 * Rebuild a Response returned or thrown by a response-route handler so request
 * effects merge consistently in production and the public dispatch primitive.
 */
export function rewrapResponseRouteResponse(result: Response): Response {
  if (isWebSocketUpgradeResponse(result)) {
    return mergeStubHeadersAndFinalize(result);
  }
  const headers = new Headers();
  result.headers.forEach((value, key) => {
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
  if (isExternalRedirect(result)) {
    markExternalRedirect(rewrapped);
  }
  return rewrapped;
}

/** Origin/basename needed to resolve soft redirect targets server-side. */
export type SoftRedirectResolveOpts = {
  requestOrigin: string;
  basename?: string;
};

/**
 * Create a 204 response with X-RSC-Redirect header for stateless redirects.
 * Used during partial/action requests where fetch would auto-follow a raw
 * 3xx to a URL that renders full HTML instead of Flight data. The 204 status
 * prevents auto-follow; the client reads the header and re-navigates via
 * the router.
 *
 * The header value is resolved with {@link resolveSoftRedirectUrl} so a
 * cross-origin / unsafe-scheme target is neutralized before it leaves the
 * server (defense-in-depth; client validators still run).
 */
export function createSimpleRedirectResponse(
  redirectUrl: string,
  opts: SoftRedirectResolveOpts & { external?: boolean },
): Response {
  const resolved = resolveSoftRedirectUrl(
    redirectUrl,
    opts.requestOrigin,
    opts.basename,
    opts.external,
  );
  return createResponseWithMergedHeaders(null, {
    status: 204,
    headers: { "X-RSC-Redirect": resolved },
  });
}

/**
 * Carry over headers from a source redirect Response to a wrapper Response.
 * Skips Location and X-RSC-Redirect (intentionally replaced by the wrapper) and
 * appends Set-Cookie to avoid clobbering multiple cookie headers.
 *
 * This is a GENERIC copier used by every redirect-rebuild path (PE
 * extractRedirectResponse, the SPA intercept below, the guard's neutralize
 * rebuild), so it has two redirect-specific jobs:
 *
 * 1. NEVER copy the reserved external-redirect header: it is no longer a trust
 *    signal (the opt-in is the out-of-band brand), and a forged value from a
 *    proxied upstream must not ride a rebuilt response to the browser.
 * 2. Transfer the out-of-band external brand: a rebuilt document-native redirect
 *    has to carry the opt-in to the guard chokepoint, which reads and clears it.
 *    Without this transfer, redirect(url, { external: true }) would be silently
 *    neutralized on any rebuild path (fail-closed, but a feature regression).
 */
export function carryOverRedirectHeaders(
  source: Response,
  target: Response,
): void {
  source.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (lower === "location" || lower === "x-rsc-redirect") return;
    if (lower === EXTERNAL_REDIRECT_MARKER) return;
    if (lower === "set-cookie") {
      target.headers.append(name, value);
    } else if (!target.headers.has(name)) {
      target.headers.set(name, value);
    }
  });
  if (isExternalRedirect(source)) {
    markExternalRedirect(target);
  }
}

/**
 * If a response is a 3xx redirect during a partial (client-side) request,
 * intercept it and return a Flight-compatible redirect instead.
 * fetch() auto-follows 3xx which would hit a URL that renders full HTML
 * the client can't parse. Returns null if the response is not a redirect.
 *
 * Soft redirect targets are resolved server-side (same-origin / external
 * scheme rules) via `opts` before they are written into X-RSC-Redirect or
 * handed to the Flight factory.
 */
export function interceptRedirectForPartial(
  response: Response,
  createRedirectFlightResponse: (
    redirectUrl: string,
    locationState?: Record<string, unknown>,
    external?: boolean,
  ) => Response,
  opts: SoftRedirectResolveOpts,
): Response | null {
  if (!isRedirectResponse(response)) {
    return null;
  }
  const redirectUrl = response.headers.get("Location")!;
  // redirect(url, { external: true }) marks an explicit off-host redirect via
  // the out-of-band brand (not a wire header). On the SPA/action channel the
  // intent must travel as a Flight payload (metadata.redirect.external) so the
  // client does a scheme-validated hard navigation (location.assign) rather than
  // a partial fetch. The client re-validates the scheme; see partial-update.ts.
  const external = isExternalRedirect(response);
  const locationState = getLocationState();
  let intercepted: Response;
  if (locationState) {
    intercepted = createRedirectFlightResponse(
      redirectUrl,
      resolveLocationStateEntries(locationState),
      external,
    );
  } else if (external) {
    intercepted = createRedirectFlightResponse(redirectUrl, undefined, true);
  } else {
    intercepted = createSimpleRedirectResponse(redirectUrl, opts);
  }

  carryOverRedirectHeaders(response, intercepted);
  // Defense-in-depth at the SPA browser-facing exit: carryOverRedirectHeaders
  // already refuses to copy the reserved marker, but strip any value that might
  // exist on `intercepted` so a forged header can never ride the 200/204 to the
  // browser. The external intent travels in metadata.redirect.external (Flight),
  // where the client re-validates the scheme.
  try {
    intercepted.headers.delete(EXTERNAL_REDIRECT_MARKER);
  } catch {
    // Immutable headers: the marker was never copied here, so this is inert.
  }

  return intercepted;
}

/**
 * Attach location state set during a request to a payload's metadata.
 * No-op if no location state was set. Callers must ensure payload.metadata
 * is populated (the non-null assertion holds for the partial/action payloads
 * that reach this helper).
 */
export function attachLocationStateIfPresent(payload: RscPayload): void {
  const locationState = getLocationState();
  if (locationState) {
    payload.metadata!.locationState =
      resolveLocationStateEntries(locationState);
  }
}

/**
 * Only cache successful responses. Non-200 statuses (errors, redirects) are
 * not cached -- notFound() produces 500 in response routes, and explicit
 * non-200 Responses are rare enough that caching them would be surprising.
 */
export function isCacheableStatus(status: number): boolean {
  return status === 200;
}

/**
 * Convert route-level middleware entries to the format expected by
 * executeMiddleware. Route middleware from previewMatch carries just
 * { handler, params }; this wraps them in the full MiddlewareEntry shape.
 */
export function buildRouteMiddlewareEntries<TEnv>(
  routeMiddleware: Array<{
    handler: MiddlewareFn;
    params: Record<string, string>;
  }>,
): Array<{ entry: MiddlewareEntry<TEnv>; params: Record<string, string> }> {
  return routeMiddleware.map((mw) => ({
    entry: {
      pattern: null,
      regex: null,
      paramNames: [],
      handler: mw.handler,
    } as MiddlewareEntry<TEnv>,
    params: mw.params,
  }));
}

/**
 * Merge stub headers from the request context onto an existing Response in
 * place, then drain onResponse callbacks. Used when a Response cannot flow
 * through `new Response()` — status 101 is outside the constructor's
 * 200-599 range, and the Cloudflare-specific `webSocket` property would be
 * lost on reconstruction.
 */
export function mergeStubHeadersAndFinalize(response: Response): Response {
  const ctx = _getRequestContext();
  if (!ctx) return response;

  applyStubHeaders(response.headers, ctx.res.headers);
  ctx.res.headers.delete("set-cookie");

  return drainOnResponseCallbacks(ctx, response);
}

/**
 * Run onResponse callbacks on an existing Response. Used by code paths that
 * bypass createResponseWithMergedHeaders (e.g. middleware short-circuits)
 * but still need ctx.onResponse() callbacks to fire.
 */
export function finalizeResponse(response: Response): Response {
  const ctx = _getRequestContext();
  if (!ctx) return response;
  return drainOnResponseCallbacks(ctx, response);
}

/** Match and stamp params/routeName on the request context as one operation. */
export async function matchAndRecordParams<TEnv>(
  ctx: HandlerContext<TEnv>,
  request: Request,
  env: TEnv,
): Promise<Awaited<ReturnType<HandlerContext<TEnv>["router"]["match"]>>> {
  const match = await ctx.router.match(request, { env });
  setRequestContextParams(match.params, match.routeName);
  return match;
}
