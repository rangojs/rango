/**
 * SSR Setup Utilities
 *
 * Manages early kickoff and retrieval of SSR module loading and stream mode
 * resolution. Both operations are request-scoped but independent of route
 * matching, so they can run in parallel with segment resolution.
 */

import type { HandlerContext } from "./handler-context.js";
import type { SSRModule } from "./types.js";
import type { SSRStreamMode } from "../router/router-options.js";
import type { MetricsStore } from "../server/context.js";
import { appendMetric } from "../router/metrics.js";
import { _getRequestContext } from "../server/request-context.js";

export type SSRSetup = readonly [SSRModule, SSRStreamMode];

/**
 * Key used to stash the early SSR setup promise on request variables.
 * Read back via `getSSRSetup`.
 */
export const SSR_SETUP_VAR = "__ssrSetup";

/**
 * Start loading the SSR module and resolving the stream mode in parallel.
 * When a `getMetricsStore` getter is provided, records individual
 * `ssr:module-load` and `ssr:stream-mode` metrics (the getter is called
 * lazily so stores created after kickoff are still captured). Without a
 * getter the promises run bare — no `.then()` microtasks, no
 * `performance.now()` calls — keeping the non-debug hot path lean.
 */
export function startSSRSetup<TEnv>(
  ctx: HandlerContext<TEnv>,
  request: Request,
  env: TEnv,
  url: URL,
  getMetricsStore?: () => MetricsStore | undefined,
): Promise<SSRSetup> {
  if (!getMetricsStore) {
    return Promise.all([
      ctx.loadSSRModule(),
      ctx.resolveStreamMode(request, env, url),
    ]);
  }
  const start = performance.now();
  return Promise.all([
    ctx.loadSSRModule().then((mod) => {
      appendMetric(
        getMetricsStore(),
        "ssr:module-load",
        start,
        performance.now() - start,
      );
      return mod;
    }),
    ctx.resolveStreamMode(request, env, url).then((mode) => {
      appendMetric(
        getMetricsStore(),
        "ssr:stream-mode",
        start,
        performance.now() - start,
      );
      return mode;
    }),
  ]);
}

/**
 * Retrieve the SSR setup result. Returns the early-kicked-off promise
 * when available (stashed on request variables), otherwise starts a
 * fresh setup.
 */
export function getSSRSetup<TEnv>(
  ctx: HandlerContext<TEnv>,
  request: Request,
  env: TEnv,
  url: URL,
  metricsStore: MetricsStore | undefined,
): Promise<SSRSetup> {
  const early = _getRequestContext()?._variables?.[SSR_SETUP_VAR] as
    | Promise<SSRSetup>
    | undefined;
  if (early) return early;
  return startSSRSetup(
    ctx,
    request,
    env,
    url,
    metricsStore ? () => metricsStore : undefined,
  );
}

/**
 * Classify whether a request may require SSR (HTML rendering).
 *
 * Returns false for requests that are definitively RSC-only, loader fetches,
 * prerender collection, or Accept-based RSC (no text/html). This mirrors
 * the isRscRequest decision in rsc-rendering.ts.
 *
 * Note: response/mime routes are excluded by the caller — this function
 * runs after classifyRequest() determines the request mode.
 */
export function mayNeedSSR(request: Request, url: URL): boolean {
  if (
    url.searchParams.has("_rsc_partial") ||
    url.searchParams.has("_rsc_action") ||
    request.headers.has("rsc-action") ||
    url.searchParams.has("_rsc_loader") ||
    url.searchParams.has("__rsc") ||
    url.searchParams.has("__prerender_collect")
  ) {
    return false;
  }

  // Mirror the Accept-based RSC decision from rsc-rendering.ts:
  // if Accept is present and does not include text/html (and no __html override),
  // the response will be RSC, not HTML.
  const accept = request.headers.get("accept");
  if (
    accept &&
    !accept.includes("text/html") &&
    !url.searchParams.has("__html")
  ) {
    return false;
  }

  return true;
}

// Final render-time decision: is the response an RSC stream (vs HTML)? Distinct
// from mayNeedSSR, which is a conservative pre-classifier (it treats a missing
// Accept header as needing SSR; this treats it as RSC).
export function isRscRequest(
  request: Request,
  url: URL,
  isPartial: boolean,
): boolean {
  return (
    isPartial ||
    (!request.headers.get("accept")?.includes("text/html") &&
      !url.searchParams.has("__html")) ||
    url.searchParams.has("__rsc")
  );
}
