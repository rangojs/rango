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
import type { RscPayload } from "./types.js";
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
  // Retrieve handler-level timing from variables
  const reqCtx = requireRequestContext();
  const handlerTimingArr: string[] = reqCtx.var.__handlerTiming || [];
  const handlerStart: number = reqCtx.var.__handlerStart || 0;

  let payload: RscPayload;
  let serverTiming: string | undefined;
  let hasInterceptSlots = false;

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

      serverTiming = match.serverTiming;

      payload = {
        metadata: {
          pathname: url.pathname,
          segments: match.segments,
          matched: match.matched,
          diff: match.diff,
          params: match.params,
          isPartial: false,
          rootLayout: ctx.router.rootLayout,
          handles: handleStore.stream(),
          version: ctx.version,
          themeConfig: ctx.router.themeConfig,
          initialTheme: reqCtx.theme,
        },
      };
    } else {
      setRequestContextParams(result.params, result.routeName);
      serverTiming = result.serverTiming;
      hasInterceptSlots = !!result.slots;

      payload = {
        metadata: {
          pathname: url.pathname,
          segments: result.segments,
          matched: result.matched,
          diff: result.diff,
          params: result.params,
          isPartial: true,
          slots: result.slots,
          handles: handleStore.stream(),
          version: ctx.version,
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
      serverTiming = match.serverTiming;

      payload = {
        // Initial SSR can reconstruct the tree from segments + rootLayout,
        // so we omit root to avoid sending the same structure twice.

        metadata: {
          pathname: url.pathname,
          segments: match.segments,
          matched: match.matched,
          diff: match.diff,
          params: match.params,
          isPartial: false,
          rootLayout: ctx.router.rootLayout,
          handles: handleStore.stream(),
          version: ctx.version,
          themeConfig: ctx.router.themeConfig,
          initialTheme: reqCtx.theme,
        },
      };
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

  // Serialize to RSC stream
  const rscSerializeStart = performance.now();
  const rscStream = ctx.renderToReadableStream<RscPayload>(payload);
  const rscSerializeDur = performance.now() - rscSerializeStart;

  // Determine if this is an RSC request or HTML request.
  // Partial requests (_rsc_partial) are always RSC -- they come from client-side
  // navigation or prefetch fetch(). We cannot rely on Accept alone since some
  // browsers may send Accept: text/html for non-HTML requests.
  const isRscRequest =
    isPartial ||
    (!request.headers.get("accept")?.includes("text/html") &&
      !url.searchParams.has("__html")) ||
    url.searchParams.has("__rsc");

  // Build complete Server-Timing: handler phases + match/manifest + RSC serialize
  const timingParts: string[] = [...handlerTimingArr];
  if (serverTiming) {
    timingParts.push(serverTiming);
  }
  timingParts.push(`rsc-serialize;dur=${rscSerializeDur.toFixed(2)}`);

  if (isRscRequest) {
    const fullTiming = timingParts.join(", ");
    const rscHeaders: Record<string, string> = {
      "content-type": "text/x-component;charset=utf-8",
      vary: "accept, X-Rango-State, X-RSC-Router-Client-Path",
    };
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
    if (fullTiming) {
      rscHeaders["Server-Timing"] = fullTiming;
    }
    return createResponseWithMergedHeaders(rscStream, {
      headers: rscHeaders,
    });
  }

  // Delegate to SSR for HTML response
  const ssrModuleStart = performance.now();
  const [ssrModule, streamMode] = await Promise.all([
    ctx.loadSSRModule(),
    ctx.resolveStreamMode(request, env, url),
  ]);
  const ssrModuleDur = performance.now() - ssrModuleStart;
  timingParts.push(`ssr-module-load;dur=${ssrModuleDur.toFixed(2)}`);

  const ssrRenderStart = performance.now();
  const htmlStream = await ssrModule.renderHTML(rscStream, {
    nonce,
    streamMode,
  });
  const ssrRenderDur = performance.now() - ssrRenderStart;
  timingParts.push(`ssr-render-html;dur=${ssrRenderDur.toFixed(2)}`);

  // Add total handler duration
  if (handlerStart) {
    const totalHandler = performance.now() - handlerStart;
    timingParts.push(`handler-total;dur=${totalHandler.toFixed(2)}`);
  }

  const fullTiming = timingParts.join(", ");
  const htmlHeaders: Record<string, string> = {
    "content-type": "text/html;charset=utf-8",
  };
  if (fullTiming) {
    htmlHeaders["Server-Timing"] = fullTiming;
  }

  return createResponseWithMergedHeaders(htmlStream, {
    headers: htmlHeaders,
  });
}
