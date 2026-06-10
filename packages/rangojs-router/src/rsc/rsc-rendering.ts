/**
 * RSC Rendering Handler (Navigation)
 *
 * Handles RSC rendering for both partial (client-side navigation) and full
 * (initial page load) requests. Includes prerender collection for build-time
 * static generation.
 */

import {
  requireRequestContext,
  setRequestContextParams,
  getLocationState,
} from "../server/request-context.js";
import { resolveLocationStateEntries } from "../browser/react/location-state-shared.js";
import { appendMetric } from "../router/metrics.js";
import { getSSRSetup, isRscRequest } from "./ssr-setup.js";
import type { RscPayload } from "./types.js";
import type { MatchResult } from "../types.js";
import {
  createResponseWithMergedHeaders,
  createSimpleRedirectResponse,
} from "./helpers.js";
import type { HandlerContext } from "./handler-context.js";

export async function handleRscRendering<TEnv>(
  ctx: HandlerContext<TEnv>,
  request: Request,
  env: TEnv,
  url: URL,
  isPartial: boolean,
  handleStore: ReturnType<typeof requireRequestContext>["_handleStore"],
  nonce: string | undefined,
): Promise<Response> {
  const reqCtx = requireRequestContext();

  let payload: RscPayload;
  let hasInterceptSlots = false;

  // Shared by the partial-fallback and full-render paths. The partial-success
  // payload below is intentionally different (omits rootLayout/theme, adds slots).
  const buildFullPayload = (m: MatchResult): RscPayload => ({
    metadata: {
      pathname: url.pathname,
      routerId: ctx.router.id,
      basename: ctx.router.basename,
      segments: m.segments,
      matched: m.matched,
      diff: m.diff,
      resolvedIds: m.resolvedIds,
      params: m.params,
      isPartial: false,
      rootLayout: ctx.router.rootLayout,
      handles: handleStore.stream(),
      version: ctx.version,
      prefetchCacheTTL: ctx.router.prefetchCacheTTL,
      themeConfig: ctx.router.themeConfig,
      initialTheme: reqCtx.theme,
    },
  });

  if (isPartial) {
    // Partial render (navigation)
    const result = await ctx.router.matchPartial(request, { env });

    if (!result) {
      // Fall back to full render
      const match = await ctx.router.match(request, { env });
      setRequestContextParams(match.params, match.routeName);

      if (match.redirect) {
        // Partial request: use X-RSC-Redirect header so the client can
        // perform SPA navigation. A raw 308 would be auto-followed by
        // fetch, hitting the target without _rsc_partial.
        return createSimpleRedirectResponse(match.redirect);
      }

      payload = buildFullPayload(match);
    } else {
      setRequestContextParams(result.params, result.routeName);

      hasInterceptSlots = !!result.slots;

      payload = {
        metadata: {
          pathname: url.pathname,
          // routerId is serialized on every payload (including within-session
          // ones) so the frontend can read the current app/router identity. It
          // always equals the current app's id: a cross-app navigation is
          // intercepted server-side (X-RSC-Reload) and never delivers a
          // different-router payload to the client.
          routerId: ctx.router.id,
          segments: result.segments,
          matched: result.matched,
          diff: result.diff,
          resolvedIds: result.resolvedIds,
          params: result.params,
          isPartial: true,
          slots: result.slots,
          handles: handleStore.stream(),
          version: ctx.version,
          prefetchCacheTTL: ctx.router.prefetchCacheTTL,
        },
      };
    }
  } else {
    // Full render (initial page load)
    const match = await ctx.router.match(request, { env });
    setRequestContextParams(match.params, match.routeName);

    if (match.redirect) {
      return createResponseWithMergedHeaders(null, {
        status: 308,
        headers: { Location: match.redirect },
      });
    }

    // Caching is now handled in router.match() via cache provider in request context
    // match.segments already contains cached or fresh segments as appropriate

    if (url.searchParams.has("__prerender_collect")) {
      // Build-time prerender collection: serialize segments and handle data
      // to JSON for storage as build artifacts. At runtime the worker
      // deserializes these and feeds them through the normal segment pipeline.
      const nonLoaderSegments = match.segments.filter(
        (s) => s.type !== "loader",
      );
      handleStore.seal();
      await handleStore.settled;
      const { serializeSegments } = await import("../cache/segment-codec.js");
      const serializedSegments = await serializeSegments(nonLoaderSegments);
      const handles: Record<string, Record<string, unknown[]>> = {};
      for (const seg of nonLoaderSegments) {
        const segHandles = handleStore.getDataForSegment(seg.id);
        if (Object.keys(segHandles).length > 0) {
          handles[seg.id] = segHandles;
        }
      }
      return new Response(
        JSON.stringify({
          segments: serializedSegments,
          handles,
          routeName: match.routeName,
          params: match.params,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    } else {
      payload = buildFullPayload(match);
    }
  }

  // For partial requests, include any server-set location state in the payload.
  // SSR (full page) requests ignore location state since there's no history.state
  // to write to on a fresh page load.
  if (isPartial && payload.metadata) {
    const locationState = getLocationState();
    if (locationState) {
      payload.metadata.locationState =
        resolveLocationStateEntries(locationState);
    }
  }

  const metricsStore = reqCtx._metricsStore;
  const renderStart = performance.now();

  // Serialize to RSC stream
  const rscSerializeStart = performance.now();
  const rscStream = ctx.renderToReadableStream<RscPayload>(payload, {
    onError: (error: unknown) => {
      ctx.callOnError(error, "rendering", { request, url, env });
    },
  });
  const rscSerializeDur = performance.now() - rscSerializeStart;
  // This measures synchronous stream creation, not end-to-end stream consumption.
  appendMetric(
    metricsStore,
    "rsc-serialize",
    rscSerializeStart,
    rscSerializeDur,
  );

  if (isRscRequest(request, url, isPartial)) {
    const renderDur = performance.now() - renderStart;
    appendMetric(metricsStore, "render:total", renderStart, renderDur);
    const rscHeaders: Record<string, string> = {
      "content-type": "text/x-component;charset=utf-8",
      vary: "accept, X-Rango-State, X-RSC-Router-Client-Path",
      // Router identity, so the client can verify pre-decode (before importing
      // chunks) that this content payload belongs to its app and refuse a
      // foreign one (cache/proxy/bug). Control-only reload/redirect responses
      // are deliberately NOT stamped. See browser/response-adapter.ts.
      "X-RSC-Router-Id": ctx.router.id,
    };
    // Tell the client's prefetch cache to scope this response to its source
    // URL (instead of the default source-agnostic wildcard). Intercept
    // responses depend on the source page matching an intercept rule, so
    // they must not be reused for navigations from other sources.
    if (hasInterceptSlots) {
      rscHeaders["x-rsc-prefetch-scope"] = "source";
    }
    // Enable browser HTTP caching for prefetch responses only.
    // Requires X-Rango-Prefetch header (sent by Link prefetch fetch),
    // non-intercept context (intercept responses depend on source page),
    // and a configured cache-control value (false disables caching).
    const isPrefetch = request.headers.has("X-Rango-Prefetch");
    if (isPrefetch && isPartial && !hasInterceptSlots) {
      const cc = ctx.router.prefetchCacheControl;
      if (cc) {
        rscHeaders["cache-control"] = cc;
      }
    }
    return createResponseWithMergedHeaders(rscStream, {
      headers: rscHeaders,
    });
  }

  // Delegate to SSR for HTML response (reuse early setup if available)
  const [ssrModule, streamMode] = await getSSRSetup(
    ctx,
    request,
    env,
    url,
    metricsStore,
  );

  const ssrRenderStart = performance.now();
  const htmlStream = await ssrModule.renderHTML(rscStream, {
    nonce,
    streamMode,
  });
  const ssrRenderDur = performance.now() - ssrRenderStart;
  appendMetric(metricsStore, "ssr-render-html", ssrRenderStart, ssrRenderDur);

  const renderDur = performance.now() - renderStart;
  appendMetric(metricsStore, "render:total", renderStart, renderDur);

  return createResponseWithMergedHeaders(htmlStream, {
    headers: { "content-type": "text/html;charset=utf-8" },
  });
}
