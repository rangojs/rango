/**
 * RSC Rendering Handler (Navigation)
 *
 * Handles RSC rendering for both partial (client-side navigation) and full
 * (initial page load) requests. Includes prerender collection for build-time
 * static generation.
 */

import {
  getRequestContext,
  setRequestContextParams,
  runWithRequestContext,
  wireRenderBarrier,
} from "../server/request-context.js";
import {
  SeededShellStore,
  buildShellLoaderSeed,
} from "../cache/shell-snapshot.js";
import { appendMetric } from "../router/metrics.js";
import { observePhase, PHASES } from "../router/instrument.js";
import type { TraceSpan } from "../router/tracing.js";
import { getSSRSetup, createSsrHtmlStage, isRscRequest } from "./ssr-setup.js";
import type { RscPayload } from "./types.js";
import type { SSRModule } from "./types.js";
import type { RequestContext } from "../server/request-context.js";
import {
  createResponseWithMergedHeaders,
  createSimpleRedirectResponse,
  attachLocationStateIfPresent,
} from "./helpers.js";
import { renderRscFlightStage, renderRscResponse } from "./render-pipeline.js";
import type { HandlerContext } from "./handler-context.js";
import { gateTransitions } from "./transition-gate.js";
import { buildFullPayload } from "./full-payload.js";
import {
  scheduleShellCapture,
  resolveShellCaptureDebugSink,
  takeCaptureDebugEventForTiming,
  describeShellCaptureEvent,
  type ShellCaptureDescriptor,
} from "./shell-capture.js";
import {
  PPR_REPLAY_STATUS_HEADER,
  SHELL_STATUS_HEADER,
  resolvePprConfig,
  buildShellKey,
  isValidShellHit,
  hasIntactShellPayload,
  base64ToBytes,
  hasShellFamily,
  warnShellStoreMissingOnce,
  warnPprNonceActiveOnce,
  describeShellTailTiming,
  publishShellTailTiming,
  takeShellTailTimingForServerTiming,
  type ResolvedPprConfig,
  type ShellTailTiming,
} from "./shell-serve.js";
import {
  lookupBuildShell,
  type DevShellLookup,
} from "./shell-build-manifest.js";
import { contextGet } from "../context-var.js";
import {
  resolveSameOriginRedirect,
  safeSameOriginLanding,
} from "../redirect-origin.js";
import { nonce as nonceToken } from "./nonce.js";
import { reportCacheError } from "../cache/cache-error.js";
import { INTERNAL_RANGO_DEBUG } from "../internal-debug.js";
import type { ShellCacheEntry, ShellSnapshotRecord } from "../cache/types.js";

function resolveDevShellLookup(
  reqCtx: RequestContext<any>,
  pprConfig: ResolvedPprConfig,
): DevShellLookup | undefined {
  if (process.env.NODE_ENV === "production") return undefined;
  return {
    isPrerenderRoute: reqCtx._classifiedRoute?.matched?.pr === true,
    routeName: reqCtx._classifiedRoute?.routeKey,
    ttl: pprConfig.ttl,
    swr: pprConfig.swr,
    tags: pprConfig.tags,
    maxSnapshotBytes: pprConfig.maxSnapshotBytes,
    captureTimeout: pprConfig.captureTimeout,
  };
}

function replayableShellSnapshot(
  entry: ShellCacheEntry | undefined,
  buildVersion: string,
): ShellSnapshotRecord[] | undefined {
  if (
    !entry ||
    !isValidShellHit(entry, buildVersion) ||
    entry.handlerLiveHoles ||
    entry.transitionWhen
  ) {
    return undefined;
  }
  const snapshot = entry.snapshot;
  const hasSegments = snapshot?.some((record) => {
    if (
      !record ||
      typeof record !== "object" ||
      record.family !== "segment" ||
      typeof record.value !== "object" ||
      record.value === null
    ) {
      return false;
    }
    const segments = (record.value as { segments?: unknown }).segments;
    return Array.isArray(segments) && segments.length > 0;
  });
  return hasSegments ? snapshot : undefined;
}

export function handleRscRendering<TEnv>(
  ctx: HandlerContext<TEnv>,
  request: Request,
  env: TEnv,
  url: URL,
  isPartial: boolean,
  handleStore: ReturnType<typeof getRequestContext>["_handleStore"],
  nonce: string | undefined,
): Promise<Response> {
  // Instrument the whole render phase once through the unified API: it records
  // the "render:total" perf metric AND opens the "rango.render" span from the
  // same boundary (match -> serialize -> SSR), so the two surfaces agree.
  // Loaders kicked off during matching nest under the span; the SSR HTML pass
  // below opens "rango.ssr" the same way.
  return observePhase(PHASES.render, (span) =>
    handleRscRenderingInner(
      ctx,
      request,
      env,
      url,
      isPartial,
      handleStore,
      nonce,
      span,
    ),
  );
}

async function handleRscRenderingInner<TEnv>(
  ctx: HandlerContext<TEnv>,
  request: Request,
  env: TEnv,
  url: URL,
  isPartial: boolean,
  handleStore: ReturnType<typeof getRequestContext>["_handleStore"],
  nonce: string | undefined,
  renderSpan: TraceSpan,
): Promise<Response> {
  const reqCtx = getRequestContext();

  let payload: RscPayload;
  let hasInterceptSlots = false;
  let pprReplayHit = false;

  // --- Axis 2: integrated PPR shell serve (docs/design/ppr-shell-resume.md) ---
  //
  // COMMIT POINT: this render pass runs strictly AFTER the whole middleware
  // chain (executeRender wraps it), so no shell byte can precede a guard
  // decision — that ordering is what makes a shared shell safe. Routes
  // without the `ppr` option stay pure axis 1 at zero cost.
  let pprMiss: {
    descriptor: ShellCaptureDescriptor;
    ssrModule: SSRModule;
  } | null = null;
  if (
    !isPartial &&
    request.method === "GET" &&
    !url.searchParams.has("__prerender_collect") &&
    !isRscRequest(request, url, false) &&
    !reqCtx._dynamic
  ) {
    const pprConfig = resolvePprConfig(reqCtx._classifiedRoute?.manifestEntry);
    if (pprConfig) {
      // A per-request CSP nonce pins the route to axis 1: a shared shell would
      // freeze the capture request's nonce and CSP would reject it for every
      // other visitor. BOTH nonce sources must gate — the createRouter({ nonce })
      // provider (`nonce` param) and a middleware ctx.set(nonce, …) token write;
      // the provider-only check missed the latter (issue #656).
      const activeNonce = nonce ?? contextGet(reqCtx._variables, nonceToken);
      const store = reqCtx._cacheStore;
      const key = buildShellKey(url);
      // Dev Server-Timing mirror (issue #651): a capture completes AFTER its
      // triggering response committed, so its outcome can only ride a LATER
      // response's header. Read-and-clear keeps one capture = one report;
      // dev-only (see takeCaptureDebugEventForTiming).
      if (process.env.NODE_ENV !== "production" && reqCtx._metricsStore) {
        const lastCapture = takeCaptureDebugEventForTiming(key);
        if (lastCapture) {
          appendMetric(
            reqCtx._metricsStore,
            "ppr:capture",
            performance.now(),
            lastCapture.attemptMs ?? 0,
            undefined,
            // attemptMs already rides as this entry's dur — drop it from desc.
            describeShellCaptureEvent({ ...lastCapture, attemptMs: undefined }),
          );
        }
        // Same mirror for the previous HIT's tail: its per-stage numbers
        // (seed/match/handover/first-html/complete) finished after that
        // response's headers were committed, so they ride THIS request's
        // Server-Timing as `ppr:tail;dur=<complete ms>`.
        const lastTail = takeShellTailTimingForServerTiming(key);
        if (lastTail) {
          appendMetric(
            reqCtx._metricsStore,
            "ppr:tail",
            performance.now(),
            lastTail.completeMs ?? 0,
            undefined,
            // completeMs already rides as this entry's dur — drop it from desc.
            describeShellTailTiming({ ...lastTail, completeMs: undefined }),
          );
        }
      }
      if (activeNonce !== undefined) {
        // Declared intent that cannot be honored deserves a diagnostic (unlike an
        // undeclared route, which is silent): a ppr route gated off by an active
        // per-request nonce warns once per key. Axis 1 after the warning.
        warnPprNonceActiveOnce(key);
      } else if (!hasShellFamily(store)) {
        // Declared intent that cannot be honored deserves a diagnostic (unlike an
        // undeclared route, which is silent). Axis 1 after the warning.
        warnShellStoreMissingOnce(key);
      } else {
        // allReady (ssr.resolveStreaming) bypasses PPR entirely: buffering defeats
        // streaming, so bots/SEO crawlers get one complete axis-1 document.
        const [ssrModule, streamMode] = await getSSRSetup(
          ctx,
          request,
          env,
          url,
          reqCtx._metricsStore,
        );
        if (
          streamMode !== "allReady" &&
          ssrModule.resumeShellHTML &&
          ssrModule.captureShellHTML
        ) {
          const descriptor: ShellCaptureDescriptor = {
            key,
            buildVersion: ctx.version,
            ttl: pprConfig.ttl,
            swr: pprConfig.swr,
            tags: pprConfig.tags,
            captureTimeout: pprConfig.captureTimeout,
            store,
            debug: INTERNAL_RANGO_DEBUG,
            maxSnapshotBytes: pprConfig.maxSnapshotBytes,
            // The resolver owns the whole policy: option wins, the
            // INTERNAL_RANGO_DEBUG env flag lights the events up when no
            // option is set, an explicit `false` stays off.
            debugSink: resolveShellCaptureDebugSink(
              ctx.router.debugShellCapture,
            ),
          };
          // One serve funnel for BOTH entry sources (runtime store hit below,
          // build-manifest hit further down): schedule the background
          // recapture when asked, then commit the composed response.
          const serveHit = (
            entry: ShellCacheEntry,
            revalidate: boolean | undefined,
          ): Response => {
            if (revalidate) {
              scheduleShellCapture(
                ctx,
                request,
                env,
                url,
                reqCtx,
                ssrModule,
                descriptor,
              );
            }
            return serveShellHit(
              ctx,
              request,
              env,
              url,
              reqCtx,
              handleStore,
              ssrModule,
              entry,
              descriptor,
            );
          };
          let cached: Awaited<ReturnType<typeof store.getShell>> = null;
          const shellReadStart = reqCtx._metricsStore ? performance.now() : 0;
          try {
            cached = await store.getShell(key);
          } catch (error) {
            // A failing store read degrades to axis 1 (MISS), never a 500.
            reportCacheError(error, "cache-read", "[ShellServe] getShell");
          }
          if (reqCtx._metricsStore) {
            // Raw store outcome (pre-validity-gates), so a version-mismatch
            // lifecycle miss is still distinguishable from a store miss.
            appendMetric(
              reqCtx._metricsStore,
              "ppr:shell-read",
              shellReadStart,
              performance.now() - shellReadStart,
              undefined,
              cached ? "hit" : "miss",
            );
          }
          if (cached && isValidShellHit(cached.entry, ctx.version)) {
            if (!hasIntactShellPayload(cached.entry)) {
              // Corrupt stored payload (undecodable prelude / unparseable
              // postponed): a store-layer fault worth a diagnostic, unlike the
              // silent version-mismatch lifecycle misses above. Degrade to MISS
              // — pprMiss below schedules the recapture that overwrites it.
              reportCacheError(
                new Error(
                  `corrupt shell entry for "${key}": prelude/postponed failed ` +
                    "the integrity check; serving axis 1 and recapturing",
                ),
                "cache-read",
                "[ShellServe] getShell",
              );
            } else {
              // Stale (SWR) hit: serve the stale shell now, recapture in the
              // background (stampede-guarded + backoff inside scheduleShellCapture).
              return serveHit(cached.entry, cached.shouldRevalidate);
            }
          }
          // Build-time shell read-through (producer B, #699): on a runtime
          // store MISS a Prerender+ppr route serves its `vite build`-baked
          // shell through the SAME serveShellHit. lookupBuildShell owns every
          // gate and fails to null (ordinary MISS path takes over); past
          // ppr.ttl the baked entry still serves while SWR recaptures — the
          // upgrade path from build entry to runtime entry.
          const buildHit = await lookupBuildShell(
            url,
            ctx.version,
            store,
            // Dev: no build manifest exists; producer B runs on demand via
            // the dev server's /__rsc_shell endpoint for PRERENDERED routes
            // only (production's exact candidate set). Folded away in
            // production builds (NODE_ENV is a compile-time constant).
            resolveDevShellLookup(reqCtx, pprConfig),
          );
          if (buildHit) {
            // Past ppr.ttl: still serve the baked entry, recapture upgrades it.
            return serveHit(buildHit.entry, buildHit.stale);
          }
          // MISS (no entry, invalid reactVersion, or store read failure): axis 1
          // + a background capture scheduled once the response is known servable.
          pprMiss = { descriptor, ssrModule };
        }
      }
    }
  }

  if (isPartial) {
    // Partial render (navigation)
    const result = await matchPartialWithPprReplay(
      ctx,
      request,
      env,
      url,
      reqCtx,
      nonce,
      () => {
        pprReplayHit = true;
      },
    );

    if (!result) {
      // Fall back to full render
      const match = await ctx.router.match(request, { env });
      setRequestContextParams(match.params, match.routeName);

      if (match.redirect) {
        // Partial request: use X-RSC-Redirect header so the client can
        // perform SPA navigation. A raw 308 would be auto-followed by
        // fetch, hitting the target without _rsc_partial. Resolve the
        // target server-side (same open-redirect policy as 3xx).
        return createSimpleRedirectResponse(match.redirect, {
          requestOrigin: url.origin,
          basename: ctx.router.basename,
        });
      }

      payload = buildFullPayload(match, ctx, url, reqCtx, handleStore);
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
          segments: gateTransitions(
            result.segments,
            reqCtx,
            ctx.router.onError,
          ),
          matched: result.matched,
          diff: result.diff,
          resolvedIds: result.resolvedIds,
          params: result.params,
          isPartial: true,
          slots: result.slots,
          handles: handleStore.stream(),
          version: ctx.version,
          prefetchCacheTTL: ctx.router.prefetchCacheTTL,
          prefetchCacheSize: ctx.router.prefetchCacheSize,
          prefetchConcurrency: ctx.router.prefetchConcurrency,
          stateCookieName: ctx.router.resolvedStateCookieName,
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
      payload = buildFullPayload(match, ctx, url, reqCtx, handleStore);
    }
  }

  // For partial requests, include any server-set location state in the payload.
  // SSR (full page) requests ignore location state since there's no history.state
  // to write to on a fresh page load.
  if (isPartial && payload.metadata) {
    attachLocationStateIfPresent(payload);
  }

  const metricsStore = reqCtx._metricsStore;

  const rscHeaders: Record<string, string> = {
    "content-type": "text/x-component;charset=utf-8",
    vary: "accept, X-Rango-State, X-RSC-Router-Client-Path",
    // Router identity, so the client can verify pre-decode (before importing
    // chunks) that this content payload belongs to its app and refuse a
    // foreign one (cache/proxy/bug). Control-only reload/redirect responses
    // are deliberately NOT stamped. See browser/response-adapter.ts.
    "X-RSC-Router-Id": ctx.router.id,
  };
  if (pprReplayHit) {
    rscHeaders[PPR_REPLAY_STATUS_HEADER] = "HIT";
  }
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

  const isFlightResponse = isRscRequest(request, url, isPartial);
  const stageTracking = {
    mode: isPartial ? ("partial" as const) : ("full" as const),
    routeKey: reqCtx._routeName,
    span: renderSpan,
  };
  const response = await renderRscResponse(
    {
      ctx,
      request,
      env,
      url,
      payload,
      init: { headers: rscHeaders },
      tracking: stageTracking,
    },
    isFlightResponse
      ? undefined
      : {
          html: createSsrHtmlStage({
            ctx,
            request,
            env,
            url,
            metricsStore,
            render: { nonce },
            init: { headers: { "content-type": "text/html;charset=utf-8" } },
          }),
        },
  );

  // --- Axis 2: PPR shell CAPTURE on MISS (background task; see design doc) ---
  // Capture only a 200 HTML document (a 404/error render is not a cacheable
  // shell). Capture does not flow through the HTTP pipeline — middleware never
  // re-runs (it already ran for this request; guarding is serve-time).
  if (pprMiss && !reqCtx._dynamic) {
    if (
      response.status === 200 &&
      (response.headers.get("content-type") ?? "").includes("text/html")
    ) {
      scheduleShellCapture(
        ctx,
        request,
        env,
        url,
        reqCtx,
        pprMiss.ssrModule,
        pprMiss.descriptor,
      );
    }
    response.headers.set(SHELL_STATUS_HEADER, "MISS");
  }

  return response;
}

/**
 * Reuse a PPR capture's canonical segment record for a partial navigation.
 * The ordinary matchPartial pipeline remains authoritative: it projects the
 * cached target tree against the client's segment ids, evaluates revalidation,
 * and resolves every loader fresh. Only segment-family records are seeded;
 * captured item/response/loader values belong to document parity and must not
 * pin navigation data.
 */
async function matchPartialWithPprReplay<TEnv>(
  ctx: HandlerContext<TEnv>,
  request: Request,
  env: TEnv,
  url: URL,
  reqCtx: RequestContext<any>,
  nonce: string | undefined,
  onReplayHit: () => void,
) {
  const runMatch = () => ctx.router.matchPartial(request, { env });
  const pprConfig = resolvePprConfig(reqCtx._classifiedRoute?.manifestEntry);
  const activeNonce = nonce ?? contextGet(reqCtx._variables, nonceToken);
  const store = reqCtx._cacheStore;

  if (
    request.method !== "GET" ||
    !pprConfig ||
    reqCtx._dynamic ||
    activeNonce !== undefined ||
    !hasShellFamily(store) ||
    store.supportsPassiveShellReads !== true
  ) {
    return runMatch();
  }

  const key = buildShellKey(url);
  let cached: Awaited<ReturnType<typeof store.getShell>> = null;
  try {
    cached = await store.getShell(key, { claimRevalidation: false });
  } catch (error) {
    reportCacheError(error, "cache-read", "[NavigationPPR] getShell");
    return runMatch();
  }

  let snapshot = cached?.shouldRevalidate
    ? undefined
    : replayableShellSnapshot(cached?.entry, ctx.version);

  if (!snapshot) {
    // Production build manifests are local module data. In dev, resolving a
    // missing build shell would foreground-fetch /__rsc_shell and block an
    // otherwise ordinary navigation on capture, so replay remains runtime-only.
    const buildHit = await lookupBuildShell(url, ctx.version, store);
    if (!buildHit?.stale) {
      snapshot = replayableShellSnapshot(buildHit?.entry, ctx.version);
    }
  }

  if (!snapshot) return runMatch();

  const previousImplicitCache = reqCtx._shellImplicitCache;
  reqCtx._shellImplicitCache = {
    ttl: pprConfig.ttl,
    swr: pprConfig.swr,
    store: new SeededShellStore(store, snapshot, {
      segmentsOnly: true,
    }),
    keyPrefix: "doc",
    onHit: onReplayHit,
  };

  try {
    return await runMatch();
  } finally {
    reqCtx._shellImplicitCache = previousImplicitCache;
  }
}

/**
 * Neutralize the shell-HIT degradation redirect target. The inline
 * `location.replace` in a committed 200 body bypasses the 3xx chokepoint
 * (guardOutgoingRedirect only sees 3xx + Location), so this reuses the same
 * same-origin resolver directly: unsafe targets neutralize to the
 * redirect-guard.ts landing instead of navigating the user off-host.
 */
export function resolveShellHitRedirectTarget(
  rawTarget: string,
  requestOrigin: string,
  basename: string | undefined,
): string {
  return (
    resolveSameOriginRedirect(rawTarget, requestOrigin) ??
    safeSameOriginLanding(basename)
  );
}

/**
 * Serve a validated shell HIT: commit the stored prelude bytes NOW and run the
 * live tail behind them inside the response stream. Plain byte concatenation is
 * correct — React foster-parents content streamed after the prelude's closing
 * `</body></html>`. After the flush a failing hole cannot become a 500/redirect
 * (error UI renders inline — the documented PPR constraint). The tail promise
 * is kicked off SYNCHRONOUSLY so it runs inside the current ALS request-context
 * frame; the adapter may pull the stream outside it.
 */
function serveShellHit(
  ctx: HandlerContext<any>,
  request: Request,
  env: any,
  url: URL,
  reqCtx: RequestContext<any>,
  handleStore: ReturnType<typeof getRequestContext>["_handleStore"],
  ssrModule: SSRModule,
  entry: ShellCacheEntry,
  descriptor: ShellCaptureDescriptor,
): Response {
  const preludeBytes = base64ToBytes(entry.prelude);
  // Per-stage tail timing for the dev `ppr:tail` Server-Timing mirror. Dev
  // only (NODE_ENV folds the branch away in production builds); offsets are
  // relative to this commit point.
  const tailTiming: ShellTailTiming | null =
    process.env.NODE_ENV !== "production"
      ? {
          key: descriptor.key,
          outcome: "complete",
          preludeBytes: preludeBytes.length,
        }
      : null;
  const tailT0 = tailTiming ? performance.now() : 0;

  const createTailContext = (): RequestContext<any> => {
    const tailCtx: RequestContext<any> = Object.create(reqCtx);
    // Matching writes render state onto the derived context. Its barrier must
    // close over that same context or a streaming tail inherits the base
    // context's premature non-streaming handle snapshot.
    wireRenderBarrier(tailCtx, handleStore);
    return tailCtx;
  };

  const renderTail = async (
    activeCtx: RequestContext<any>,
  ): Promise<ReadableStream<Uint8Array> | { redirect: string }> => {
    const matchStart = INTERNAL_RANGO_DEBUG ? performance.now() : 0;
    const match = await ctx.router.match(request, { env });
    if (tailTiming) {
      tailTiming.matchMs = Math.round(performance.now() - tailT0);
    }
    if (INTERNAL_RANGO_DEBUG) {
      console.log(
        `[Server][ppr] shell HIT: tail match done +${Math.round(performance.now() - matchStart)}ms (abs ${Math.round(performance.now())}, started ${Math.round(matchStart)})`,
      );
    }
    if (match.redirect) return { redirect: match.redirect };
    setRequestContextParams(match.params, match.routeName);
    const payload = buildFullPayload(match, ctx, url, activeCtx, handleStore);
    // Theme fidelity for resume: replay the CAPTURE's initialTheme into the
    // payload so the resume/hydration trees match the frozen prelude by
    // construction. The visitor still sees THEIR theme — the prelude's FOUC
    // script applies the cookie pre-paint and ThemeProvider re-syncs post-mount.
    if (payload.metadata) {
      payload.metadata.initialTheme = entry.initialTheme as
        | import("../theme/types.js").Theme
        | undefined;
    }
    // Full Flight render per request: hydration needs the whole payload (there
    // is no Flight-side resume — a React limitation, not ours).
    const flightStage = renderRscFlightStage({
      ctx,
      request,
      env,
      url,
      payload,
      tracking: {
        mode: "full",
        routeKey: activeCtx._routeName,
      },
    });
    let rscStream = flightStage.stream;
    // Timing tap: when does the Flight render produce its FIRST byte? Compared
    // with the eager-inject/first-tail logs this proves whether hydration-start
    // latency is genuine server work (loaders) or stream plumbing holding
    // ready bytes back.
    if (INTERNAL_RANGO_DEBUG) {
      const tapStart = performance.now();
      let first = false;
      rscStream = rscStream.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            if (!first) {
              first = true;
              console.log(
                `[Server][ppr] flight render: first chunk +${Math.round(performance.now() - tapStart)}ms (abs ${Math.round(performance.now())})`,
              );
            }
            controller.enqueue(chunk);
          },
        }),
      );
    }
    return observePhase(PHASES.ssr, () =>
      ssrModule.resumeShellHTML!(rscStream, {
        postponed: entry.postponed,
        nonce: undefined,
      }),
    );
  };

  const tailPromise: Promise<
    ReadableStream<Uint8Array> | { redirect: string }
  > = (async () => {
    // Snapshot seeding (docs/design/ppr-shell-resume.md): the tail render must
    // match the frozen prelude, so pinned cache reads replay their capture-time
    // values via a SeededShellStore overlay while unpinned reads (the holes)
    // stay live. The overlay lives on a DERIVED context so the shared reqCtx is
    // untouched.
    if (entry.snapshot && entry.snapshot.length > 0) {
      const seededCtx = createTailContext();
      if (reqCtx._cacheStore) {
        seededCtx._cacheStore = new SeededShellStore(
          reqCtx._cacheStore,
          entry.snapshot,
        );
      }
      // Loader-family records (bake-lane containers, loader-container-bake):
      // decode into a seed Map for the resolveLoaderData overlay, so the
      // payload's baked container bytes match the frozen prelude while the
      // hole-marker paths keep the fresh run's live nested promises.
      const seedStart = INTERNAL_RANGO_DEBUG ? performance.now() : 0;
      const loaderSeed = await buildShellLoaderSeed(entry.snapshot);
      if (tailTiming) {
        tailTiming.seedMs = Math.round(performance.now() - tailT0);
      }
      if (INTERNAL_RANGO_DEBUG) {
        console.log(
          `[Server][ppr] shell HIT: loader seed built +${Math.round(performance.now() - seedStart)}ms (abs ${Math.round(performance.now())})`,
        );
      }
      if (loaderSeed) seededCtx._shellLoaderSeed = loaderSeed;
      // Shell fast path (serve side): if the capture recorded the implicit doc
      // segment record and the handler layer declared no liveness, the tail's
      // cache lookup HITs the seeded doc entry — the handler layer is REPLAYED,
      // not re-executed (loaders still run fresh). Anything else degrades to
      // the full tail automatically.
      if (!entry.handlerLiveHoles && !entry.transitionWhen) {
        seededCtx._shellImplicitCache = {
          ttl: descriptor.ttl,
          swr: descriptor.swr,
          keyPrefix: "doc",
        };
        if (INTERNAL_RANGO_DEBUG) {
          console.log(
            `[Server][ppr] shell HIT: fast path armed (implicit doc cache) (abs ${Math.round(performance.now())})`,
          );
        }
      } else if (INTERNAL_RANGO_DEBUG) {
        console.log(
          `[Server][ppr] shell HIT: fast path declined — request-dependent handler/transition state; tail re-runs handlers (abs ${Math.round(performance.now())})`,
        );
      }
      // Fragment splice (issue #700): store hits in THIS tail emit their stored
      // segment fragments verbatim (expanded by segment-fragments.ts). The flag
      // lives on the derived context so it can never leak into a capture render,
      // which serializes segments and must see real elements.
      seededCtx._shellFragmentPayload = true;
      return runWithRequestContext(seededCtx, () => renderTail(seededCtx));
    }
    // No snapshot (e.g. a producer B entry): still a shell-HIT tail, so arm the
    // fragment splice on a derived context — never the shared reqCtx, from which
    // scheduleShellCapture derives the capture context (the flag must not be
    // inherited there).
    const fragmentCtx = createTailContext();
    fragmentCtx._shellFragmentPayload = true;
    return runWithRequestContext(fragmentCtx, () => renderTail(fragmentCtx));
  })();
  // The stream below is the only consumer; pre-attach a no-op catch so a tail
  // failure before the stream is pulled never surfaces as an unhandled rejection.
  tailPromise.catch(() => {});

  const serveStart = INTERNAL_RANGO_DEBUG ? performance.now() : 0;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(preludeBytes);
      if (INTERNAL_RANGO_DEBUG) {
        console.log(
          `[Server][ppr] shell HIT: prelude enqueued (${preludeBytes.length}b) +${Math.round(performance.now() - serveStart)}ms`,
        );
      }
      try {
        const tail = await tailPromise;
        if (tailTiming) {
          tailTiming.handoverMs = Math.round(performance.now() - tailT0);
        }
        if (INTERNAL_RANGO_DEBUG) {
          console.log(
            `[Server][ppr] shell HIT: tail stream handed over +${Math.round(performance.now() - serveStart)}ms (abs ${Math.round(performance.now())})`,
          );
        }
        if (tail instanceof ReadableStream) {
          const reader = tail.getReader();
          let firstTailChunk = true;
          let tailBytes = 0;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (firstTailChunk) {
                firstTailChunk = false;
                if (tailTiming) {
                  tailTiming.firstHtmlMs = Math.round(
                    performance.now() - tailT0,
                  );
                }
                if (INTERNAL_RANGO_DEBUG) {
                  console.log(
                    `[Server][ppr] shell HIT: first tail chunk on the wire +${Math.round(performance.now() - serveStart)}ms (abs ${Math.round(performance.now())})`,
                  );
                }
              }
              if (tailTiming || INTERNAL_RANGO_DEBUG) {
                tailBytes += value.length;
              }
              controller.enqueue(value);
            }
          } finally {
            reader.releaseLock();
          }
          if (tailTiming) {
            tailTiming.completeMs = Math.round(performance.now() - tailT0);
            tailTiming.tailBytes = tailBytes;
          }
          // Bounds the post-header work Server-Timing structurally cannot see:
          // the HIT commits headers at the flush, so ALL live-tail time (match,
          // loaders, Flight, resume) happens inside the response body. This
          // line plus the [Server][segments] build logs narrate that window.
          if (INTERNAL_RANGO_DEBUG) {
            console.log(
              `[Server][ppr] shell HIT: tail complete +${Math.round(performance.now() - serveStart)}ms (${tailBytes}b)`,
            );
          }
        } else {
          // Defensive, near-unreachable: a redirecting match cannot have captured
          // a shell (capture bails on redirects), so a HIT on a redirecting URL
          // requires the route to have BECOME redirecting within the shell TTL.
          // The 200 + prelude are already committed; degrade to a client-side
          // replace so the user still lands on the target. The target is
          // neutralized first (see resolveShellHitRedirectTarget).
          const safeTarget = resolveShellHitRedirectTarget(
            tail.redirect,
            url.origin,
            ctx.router.basename,
          );
          controller.enqueue(
            new TextEncoder().encode(
              `<script>location.replace(${JSON.stringify(safeTarget)})</script>`,
            ),
          );
          if (tailTiming) {
            tailTiming.outcome = "redirect";
            tailTiming.completeMs = Math.round(performance.now() - tailT0);
          }
        }
        if (tailTiming) publishShellTailTiming(tailTiming);
        controller.close();
      } catch (error) {
        // Self-heal on a failed tail: errors the pre-commit gates cannot catch
        // (mismatched postponed blob, hard render error above the holes) throw
        // here AFTER the 200 + prelude flushed and would re-fail on every
        // request until the entry ages out — recapture overwrites the entry.
        // Client disconnects land here too; the recapture is idempotent and
        // bounded by scheduleShellCapture's stampede guard + backoff.
        scheduleShellCapture(
          ctx,
          request,
          env,
          url,
          reqCtx,
          ssrModule,
          descriptor,
        );
        if (tailTiming) {
          tailTiming.outcome = "error";
          tailTiming.completeMs = Math.round(performance.now() - tailT0);
          publishShellTailTiming(tailTiming);
        }
        controller.error(error);
      }
    },
  });

  return createResponseWithMergedHeaders(body, {
    headers: {
      "content-type": "text/html;charset=utf-8",
      [SHELL_STATUS_HEADER]: "HIT",
    },
  });
}
