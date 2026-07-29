/**
 * SSR Setup Utilities
 *
 * Manages early kickoff and retrieval of SSR module loading and stream mode
 * resolution. Both operations are request-scoped but independent of route
 * matching, so they can run in parallel with segment resolution.
 */

import type { HandlerContext } from "./handler-context.js";
import type { SSRModule, SSRRenderOptions } from "./types.js";
import type { SSRStreamMode } from "../router/router-options.js";
import type { MetricsStore } from "../server/context.js";
import type {
  RscFlightStage,
  RscPreparedHtmlRender,
} from "./render-pipeline.js";
import { appendMetric } from "../router/metrics.js";
import {
  parseAcceptTypes,
  prefersFlightRepresentation,
  RSC_WIRE_MIME,
} from "../router/content-negotiation.js";
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

export interface SsrHtmlStageOptions<TEnv> {
  ctx: HandlerContext<TEnv>;
  request: Request;
  env: TEnv;
  url: URL;
  /** Metrics store for ssr:module-load / ssr:stream-mode timing (per call site). */
  metricsStore: MetricsStore | undefined;
  /**
   * renderHTML options minus streamMode (the stage resolves streamMode). Carries
   * the per-site nonce and, for the PE action re-render, formState. Spread
   * verbatim so each call site's exact key set is preserved.
   */
  render: Omit<SSRRenderOptions, "streamMode">;
  /** ResponseInit merged into the prepared render (e.g. content-type). */
  init?: ResponseInit;
}

/**
 * Build the `html` stage callback renderRscResponse drives: await the (possibly
 * early-kicked-off) SSR setup, then renderHTML over the Flight stream. The four
 * render paths (rsc-rendering full/partial, 404, PE, PE-error) differ only in
 * metricsStore, render options (nonce/formState), and init — threaded here so
 * the getSSRSetup + renderHTML wiring lives in one place.
 */
export function createSsrHtmlStage<TEnv>(
  options: SsrHtmlStageOptions<TEnv>,
): (flight: RscFlightStage) => Promise<RscPreparedHtmlRender> {
  return async (flight) => {
    const [ssrModule, streamMode] = await getSSRSetup(
      options.ctx,
      options.request,
      options.env,
      options.url,
      options.metricsStore,
    );
    return {
      render: () =>
        // search: the LIVE request's query string, threaded out-of-band into
        // the SSR pass so useSearchParams sees real values during document
        // renders. Deliberately not payload metadata: cached/prerendered
        // payloads replay captured metadata, and search is not route
        // identity — it must always come from the request being served.
        ssrModule.renderHTML(flight.stream, {
          ...options.render,
          streamMode,
          search: options.url.search,
          // origin: same out-of-band channel — seeds the SSR store location
          // so origin-dependent markup (Link's data-external) agrees with the
          // browser's window.location across hydration.
          origin: options.url.origin,
        }),
      ...(options.init && { init: options.init }),
    };
  };
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
 * Accept-based flight opt-in: the client explicitly listed the RSC wire
 * format (text/x-component) in Accept, ranked above the HTML document, and
 * did not override with __html.
 *
 * The flight stream is an internal transport representation — it is served
 * ONLY on explicit opt-in (this Accept value, or the _rsc_ / __rsc transport
 * params). Everything else (missing Accept, wildcards, application/json,
 * browser Accept strings) gets the HTML document, per RFC 9110: a missing
 * Accept is equivalent to a full wildcard, and a wildcard gets the server's
 * canonical representation. The old rule ("no text/html substring → flight")
 * handed the wire format to every generic client — curl, health checks,
 * link unfurlers.
 *
 * The includes() guard is a parse-skipping fast path: the bulk of traffic
 * (browsers, curl, monitors) never mentions the wire format and pays no
 * parseAcceptTypes allocation. Ranking lives in prefersFlightRepresentation
 * (router/content-negotiation.ts), co-located with the candidate MIME set.
 */
function acceptsFlightExplicitly(request: Request, url: URL): boolean {
  if (url.searchParams.has("__html")) return false;
  const accept = request.headers.get("accept");
  if (accept === null || !accept.includes(RSC_WIRE_MIME)) return false;
  return prefersFlightRepresentation(parseAcceptTypes(accept));
}

/**
 * Classify whether a request may require SSR (HTML rendering).
 *
 * Returns false for requests that are definitively RSC-only: transport
 * params (partial/action/loader/__rsc), prerender collection, or an explicit
 * Accept: text/x-component. Must never return false for a request whose
 * render-time decision (isRscRequest) will be HTML — the two share
 * acceptsFlightExplicitly so the Accept rule cannot drift. document-cache.ts
 * keys its HTML/RSC response slots off this function, so any divergence from
 * the render decision poisons a cache slot with the wrong representation.
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

  return !acceptsFlightExplicitly(request, url);
}

// Final render-time decision: is the response an RSC stream (vs HTML)?
// Flight requires explicit opt-in: the partial transport param, __rsc, or
// Accept: text/x-component. mayNeedSSR is the coarse pre-filter over the
// transport params; both delegate the Accept call to acceptsFlightExplicitly.
//
// _rsc_partial is read from the URL in addition to the plan-derived isPartial
// flag: the 404 fallback plan hardcodes mode "full-render" even for partial
// navigations (handler.ts RouteNotFoundError catch), so a partial 404 reaches
// this decision with isPartial=false. The old Accept rule masked that by
// classifying */* as flight; without the URL check a client-side navigation
// to a missing route received an HTML 404 it cannot apply, and the
// navigation never committed (multi-router soft-404, popstate not-found).
export function isRscRequest(
  request: Request,
  url: URL,
  isPartial: boolean,
): boolean {
  return (
    isPartial ||
    url.searchParams.has("_rsc_partial") ||
    url.searchParams.has("__rsc") ||
    acceptsFlightExplicitly(request, url)
  );
}
