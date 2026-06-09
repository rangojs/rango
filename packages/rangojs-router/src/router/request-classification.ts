/**
 * Request Classification
 *
 * Replaces the implicit "preview then match again" model with a clean
 * two-stage architecture:
 *
 * 1. Classification — classifyRequest() produces a RequestPlan that answers
 *    all routing questions once: target route, request mode, route middleware,
 *    response-route info, negotiation state.
 *
 * 2. Execution — executeRequest() dispatches on the plan to the appropriate
 *    handler (response route, loader fetch, full render, partial render,
 *    action revalidation, PE render).
 *
 * Builds on RouteSnapshot from route-snapshot.ts.
 */

import { RouteNotFoundError } from "../errors.js";
import type { EntryData } from "../server/context.js";
import type { CollectedMiddleware } from "./middleware-types.js";
import type { RouteMatchResult } from "./pattern-matching.js";
import { negotiateRoute } from "./content-negotiation.js";
import { stripInternalParams } from "./handler-context.js";
import { resolveRoute, type RouteSnapshot } from "./route-snapshot.js";

// ---------------------------------------------------------------------------
// RequestPlan — discriminated union
// ---------------------------------------------------------------------------

interface RedirectPlan<TEnv = any> {
  mode: "redirect";
  route: RouteSnapshot<TEnv>;
  redirectUrl: string;
}

interface VersionMismatchPlan<TEnv = any> {
  mode: "version-mismatch";
  /** May be undefined when version mismatch is detected before route resolution */
  route?: RouteSnapshot<TEnv>;
  reloadUrl: string;
}

interface AppSwitchReloadPlan {
  mode: "app-switch";
  /** Clean target URL (internal _rsc_* params stripped) to navigate to. */
  reloadUrl: string;
}

interface ResponseRoutePlan<TEnv = any> {
  mode: "response";
  route: RouteSnapshot<TEnv>;
  handler: Function;
  responseType: string;
  negotiated: boolean;
  manifestEntry: EntryData;
  routeMiddleware: CollectedMiddleware[];
}

interface LoaderFetchPlan<TEnv = any> {
  mode: "loader";
  route: RouteSnapshot<TEnv>;
}

interface PeRenderPlan<TEnv = any> {
  mode: "pe-render";
  route: RouteSnapshot<TEnv>;
}

interface ActionPlan<TEnv = any> {
  mode: "action";
  route: RouteSnapshot<TEnv>;
  actionId: string;
  negotiated: boolean;
}

interface FullRenderPlan<TEnv = any> {
  mode: "full-render";
  route: RouteSnapshot<TEnv>;
  negotiated: boolean;
}

interface PartialRenderPlan<TEnv = any> {
  mode: "partial-render";
  route: RouteSnapshot<TEnv>;
  negotiated: boolean;
}

/**
 * The output of request classification. A discriminated union where each
 * variant carries exactly the fields needed for its execution path.
 */
export type RequestPlan<TEnv = any> =
  | RedirectPlan<TEnv>
  | VersionMismatchPlan<TEnv>
  | AppSwitchReloadPlan
  | ResponseRoutePlan<TEnv>
  | LoaderFetchPlan<TEnv>
  | PeRenderPlan<TEnv>
  | ActionPlan<TEnv>
  | FullRenderPlan<TEnv>
  | PartialRenderPlan<TEnv>;

/**
 * Plans that have passed the terminal-check gate (version-mismatch and
 * app-switch reloads handled) and are ready for execution. Always have a
 * `route` field.
 */
export type ExecutableRequestPlan<TEnv = any> = Exclude<
  RequestPlan<TEnv>,
  VersionMismatchPlan<TEnv> | AppSwitchReloadPlan
>;

/**
 * Re-export individual plan types for consumers that need to narrow.
 */
export type {
  RedirectPlan,
  VersionMismatchPlan,
  ResponseRoutePlan,
  LoaderFetchPlan,
  PeRenderPlan,
  ActionPlan,
  FullRenderPlan,
  PartialRenderPlan,
};

// ---------------------------------------------------------------------------
// classifyRequest — the single authoritative classification step
// ---------------------------------------------------------------------------

export interface ClassifyRequestDeps<TEnv = any> {
  findMatch: (pathname: string) => RouteMatchResult<TEnv> | null;
  routerVersion: string;
  routerId: string;
}

/**
 * Classify an incoming request into a RequestPlan.
 *
 * This is the single source of truth for request mode detection. It replaces
 * the scattered previewMatch + isAction/isLoaderFetch/isPartial checks in
 * handler.ts.
 *
 * Classification order:
 * 1. Route resolution (findMatch + loadManifest via resolveRoute lite)
 * 2. Redirect detection
 * 3. Version mismatch
 * 4. Response route + content negotiation
 * 5. Mode detection from headers/params
 */
export async function classifyRequest<TEnv = any>(
  request: Request,
  url: URL,
  deps: ClassifyRequestDeps<TEnv>,
): Promise<RequestPlan<TEnv>> {
  const pathname = url.pathname;
  const isAction =
    request.headers.has("rsc-action") || url.searchParams.has("_rsc_action");

  // Version mismatch — runs BEFORE route resolution so stale clients
  // requesting removed routes get a reload, not a 404.
  const clientVersion = url.searchParams.get("_rsc_v");
  if (
    deps.routerVersion &&
    clientVersion &&
    clientVersion !== deps.routerVersion
  ) {
    // Strip internal _rsc_* params so the browser reloads to a clean URL
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
          // Malformed referer, fall back to stripped url
        }
      }
    }

    return {
      mode: "version-mismatch",
      reloadUrl,
    };
  }

  // App switch — also runs BEFORE route resolution (like version-mismatch
  // above), and for the same reason: a cross-app SPA navigation must reload
  // even when the target route does NOT exist in the target app. If we resolved
  // first, a missing route would throw RouteNotFoundError and the 404 would
  // render in-place under the SOURCE app's document — violating the invariant
  // that crossing a host-router app boundary is always a full document load.
  // A mismatched routerId (_rsc_rid) means the navigation crossed an app
  // boundary; force a real document navigation. A soft swap can't faithfully
  // re-establish the target app's document (stylesheets shared across apps are
  // dropped by React 19's by-href dedup; theme/warmup/prefetch-TTL are
  // document-lifetime — see browser/app-shell.ts). Only SPA (`_rsc_partial`)
  // requests need this; a direct full load already IS the document navigation.
  const clientRouterId = url.searchParams.get("_rsc_rid");
  if (
    clientRouterId &&
    clientRouterId !== deps.routerId &&
    url.searchParams.has("_rsc_partial")
  ) {
    return {
      mode: "app-switch",
      reloadUrl: stripInternalParams(url).toString(),
    };
  }

  // No metricsStore — classification is a lightweight gating step.
  // Route-matching and manifest-loading metrics belong in the match path
  // (createMatchContextForFull/Partial) which runs the authoritative resolution.
  const result = await resolveRoute<TEnv>(pathname, {
    findMatch: deps.findMatch,
    lite: true,
  });

  if (!result) {
    throw new RouteNotFoundError(`No route matched for ${pathname}`, {
      cause: { pathname, method: request.method },
    });
  }

  // Redirect
  if (result.type === "redirect") {
    const snapshot: RouteSnapshot<TEnv> = {
      matched: result as any,
      manifestEntry: null as any,
      entries: [],
      routeKey: "",
      localRouteName: "",
      params: {},
      routeMiddleware: [],
      cacheScope: null,
      isPassthrough: false,
    };
    return {
      mode: "redirect",
      route: snapshot,
      redirectUrl: result.redirectTo + url.search,
    };
  }

  const snapshot = result.snapshot;

  // Response route — non-RSC short-circuit (JSON, streaming, etc.)
  const responseResult = await classifyResponseRoute(
    request,
    pathname,
    snapshot,
  );
  if (responseResult) {
    return responseResult;
  }

  // Mode detection from request signals
  const actionId =
    request.headers.get("rsc-action") || url.searchParams.get("_rsc_action");
  const isLoaderFetch = url.searchParams.has("_rsc_loader");

  const hasVariants =
    snapshot.matched.negotiateVariants &&
    snapshot.matched.negotiateVariants.length > 0;
  const negotiated = !!hasVariants;

  if (isAction && actionId) {
    return { mode: "action", route: snapshot, actionId, negotiated };
  }

  if (isLoaderFetch) {
    return { mode: "loader", route: snapshot };
  }

  // PE detection: POST with form content-type, but not a server action
  const contentType = request.headers.get("content-type") || "";
  const isFormSubmission =
    contentType.includes("multipart/form-data") ||
    contentType.includes("application/x-www-form-urlencoded");
  if (request.method === "POST" && !isAction && isFormSubmission) {
    return { mode: "pe-render", route: snapshot };
  }

  if (url.searchParams.has("_rsc_partial")) {
    return { mode: "partial-render", route: snapshot, negotiated };
  }

  return { mode: "full-render", route: snapshot, negotiated };
}

// ---------------------------------------------------------------------------
// Content negotiation for response routes
// ---------------------------------------------------------------------------

/**
 * Check if the route is a response route and perform content negotiation
 * if negotiate variants exist. Returns a ResponseRoutePlan if the route
 * is a response route, null otherwise (RSC route).
 */
async function classifyResponseRoute<TEnv>(
  request: Request,
  pathname: string,
  snapshot: RouteSnapshot<TEnv>,
): Promise<ResponseRoutePlan<TEnv> | null> {
  // negotiateRoute returns the response plan (variant or plain) or null for RSC.
  const negotiation = await negotiateRoute(request, pathname, snapshot);
  return negotiation
    ? { mode: "response", route: snapshot, ...negotiation }
    : null;
}
