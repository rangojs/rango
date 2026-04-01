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
import { collectRouteMiddleware } from "./middleware.js";
import { traverseBack } from "./pattern-matching.js";
import type { RouteMatchResult } from "./pattern-matching.js";
import {
  parseAcceptTypes,
  RSC_RESPONSE_TYPE,
  pickNegotiateVariant,
} from "./content-negotiation.js";
import { loadManifest } from "./manifest.js";
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
  route: RouteSnapshot<TEnv>;
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
  routeMiddleware: CollectedMiddleware[];
}

interface PeRenderPlan<TEnv = any> {
  mode: "pe-render";
  route: RouteSnapshot<TEnv>;
  routeMiddleware: CollectedMiddleware[];
}

interface ActionPlan<TEnv = any> {
  mode: "action";
  route: RouteSnapshot<TEnv>;
  actionId: string;
  routeMiddleware: CollectedMiddleware[];
  negotiated: boolean;
}

interface FullRenderPlan<TEnv = any> {
  mode: "full-render";
  route: RouteSnapshot<TEnv>;
  routeMiddleware: CollectedMiddleware[];
  negotiated: boolean;
}

interface PartialRenderPlan<TEnv = any> {
  mode: "partial-render";
  route: RouteSnapshot<TEnv>;
  routeMiddleware: CollectedMiddleware[];
  negotiated: boolean;
}

/**
 * The output of request classification. A discriminated union where each
 * variant carries exactly the fields needed for its execution path.
 */
export type RequestPlan<TEnv = any> =
  | RedirectPlan<TEnv>
  | VersionMismatchPlan<TEnv>
  | ResponseRoutePlan<TEnv>
  | LoaderFetchPlan<TEnv>
  | PeRenderPlan<TEnv>
  | ActionPlan<TEnv>
  | FullRenderPlan<TEnv>
  | PartialRenderPlan<TEnv>;

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

  // 1. Route resolution (lite mode — skip entries/cacheScope)
  const result = await resolveRoute<TEnv>(pathname, {
    findMatch: deps.findMatch,
    lite: true,
  });

  if (!result) {
    throw new RouteNotFoundError(`No route matched for ${pathname}`, {
      cause: { pathname, method: request.method },
    });
  }

  // 2. Redirect
  if (result.type === "redirect") {
    // Build a minimal snapshot for the redirect plan. The route was matched
    // but is a redirect — we still need the matched data for potential
    // logging/telemetry, but most fields are empty since we won't render.
    // Redirects are typically handled by the pipeline (match/matchPartial),
    // but classifyRequest surfaces them early so handler.ts can dispatch
    // without entering the pipeline at all.
    //
    // Since resolveRoute returns early for redirects (before loadManifest),
    // we don't have a full snapshot. Throw RouteNotFoundError-like? No —
    // redirects are a valid classification outcome. We need a second
    // resolveRoute call to get the snapshot... but that defeats lite mode.
    //
    // Simpler: for redirects, the plan doesn't need a full route snapshot.
    // The redirect URL is all executeRequest needs.
    // Use a minimal synthetic snapshot.
    const snapshot: RouteSnapshot<TEnv> = {
      matched: result as any, // The RouteMatchResult with redirectTo
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

  // 3. Version mismatch — client has stale code after HMR/deployment
  const clientVersion = url.searchParams.get("_rsc_v");
  if (
    deps.routerVersion &&
    clientVersion &&
    clientVersion !== deps.routerVersion
  ) {
    const isAction =
      request.headers.has("rsc-action") || url.searchParams.has("_rsc_action");

    let reloadUrl = url.toString();
    if (isAction) {
      const referer = request.headers.get("referer");
      if (referer) {
        try {
          const refererUrl = new URL(referer);
          if (refererUrl.origin === url.origin) {
            reloadUrl = referer;
          }
        } catch {
          // Malformed referer, fall back to url
        }
      }
    }

    return {
      mode: "version-mismatch",
      route: snapshot,
      reloadUrl,
    };
  }

  // 4. Response route — non-RSC short-circuit (JSON, streaming, etc.)
  const responseResult = await classifyResponseRoute(
    request,
    pathname,
    snapshot,
  );
  if (responseResult) {
    return responseResult;
  }

  // 5. Mode detection from request signals
  const isAction =
    request.headers.has("rsc-action") || url.searchParams.has("_rsc_action");
  const actionId =
    request.headers.get("rsc-action") || url.searchParams.get("_rsc_action");
  const isLoaderFetch = url.searchParams.has("_rsc_loader");

  const routeMiddleware = snapshot.routeMiddleware;
  const hasVariants =
    snapshot.matched.negotiateVariants &&
    snapshot.matched.negotiateVariants.length > 0;
  const negotiated = !!hasVariants;

  if (isAction && actionId) {
    return {
      mode: "action",
      route: snapshot,
      actionId,
      routeMiddleware,
      negotiated,
    };
  }

  if (isLoaderFetch) {
    return {
      mode: "loader",
      route: snapshot,
      routeMiddleware,
    };
  }

  // PE detection: POST with form content-type, but not a server action
  const contentType = request.headers.get("content-type") || "";
  const isFormSubmission =
    contentType.includes("multipart/form-data") ||
    contentType.includes("application/x-www-form-urlencoded");
  if (request.method === "POST" && !isAction && isFormSubmission) {
    return {
      mode: "pe-render",
      route: snapshot,
      routeMiddleware,
    };
  }

  // App switch: client's routerId doesn't match this router
  const clientRouterId = url.searchParams.get("_rsc_rid");
  const isAppSwitch = !!(clientRouterId && clientRouterId !== deps.routerId);
  const isPartial = url.searchParams.has("_rsc_partial") && !isAppSwitch;

  if (isPartial) {
    return {
      mode: "partial-render",
      route: snapshot,
      routeMiddleware,
      negotiated,
    };
  }

  return {
    mode: "full-render",
    route: snapshot,
    routeMiddleware,
    negotiated,
  };
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
  const { matched, manifestEntry, routeMiddleware, responseType } = snapshot;

  // Content negotiation: when negotiate variants exist, pick the best
  // handler based on the Accept header.
  if (matched.negotiateVariants && matched.negotiateVariants.length > 0) {
    const acceptEntries = parseAcceptTypes(request.headers.get("accept") || "");

    // Build candidate list preserving definition order.
    const variants = matched.negotiateVariants;
    let candidates: Array<{ routeKey: string; responseType: string }>;
    if (responseType) {
      candidates = [...variants, { routeKey: matched.routeKey, responseType }];
    } else {
      const rscCandidate = {
        routeKey: matched.routeKey,
        responseType: RSC_RESPONSE_TYPE,
      };
      candidates = matched.rscFirst
        ? [rscCandidate, ...variants]
        : [...variants, rscCandidate];
    }

    const variant = pickNegotiateVariant(acceptEntries, candidates);

    // RSC won negotiation — not a response route
    if (variant.responseType === RSC_RESPONSE_TYPE) {
      return null;
    }

    // Response-type primary won, already set
    if (responseType && variant.routeKey === matched.routeKey) {
      return {
        mode: "response",
        route: snapshot,
        handler:
          manifestEntry.type === "route" ? manifestEntry.handler : undefined!,
        responseType,
        negotiated: true,
        manifestEntry,
        routeMiddleware,
      };
    }

    // Different variant won — load its manifest entry
    const negotiateEntry = await loadManifest(
      matched.entry,
      variant.routeKey,
      pathname,
      undefined,
      false,
    );
    const variantMiddleware = collectRouteMiddleware(
      traverseBack(negotiateEntry),
      matched.params,
    );
    return {
      mode: "response",
      route: snapshot,
      handler:
        negotiateEntry.type === "route" ? negotiateEntry.handler : undefined!,
      responseType: variant.responseType,
      negotiated: true,
      manifestEntry: negotiateEntry,
      routeMiddleware: variantMiddleware,
    };
  }

  // Non-negotiated response route
  if (responseType) {
    const handler =
      manifestEntry.type === "route" ? manifestEntry.handler : undefined;
    if (handler) {
      return {
        mode: "response",
        route: snapshot,
        handler,
        responseType,
        negotiated: false,
        manifestEntry,
        routeMiddleware,
      };
    }
  }

  return null;
}
