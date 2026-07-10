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
  type ShellTailTiming,
} from "./shell-serve.js";
import { lookupBuildShell } from "./shell-build-manifest.js";
import { contextGet } from "../context-var.js";
import {
  resolveSameOriginRedirect,
  safeSameOriginLanding,
} from "../redirect-origin.js";
import { nonce as nonceToken } from "./nonce.js";
import { reportCacheError } from "../cache/cache-error.js";
import { INTERNAL_RANGO_DEBUG } from "../internal-debug.js";
import type { ShellCacheEntry } from "../cache/types.js";

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

  // --- Axis 2: integrated PPR shell serve (docs/design/ppr-shell-resume.md) ---
  //
  // COMMIT POINT. This function is the render pass executeRender wraps, so it runs
  // strictly AFTER the whole middleware chain — the global router.use() chain AND
  // route DSL middleware() both wrap it. Any middleware rejection/redirect/401 has
  // already returned before this line, which is what makes a shared shell safe:
  // not a single shell byte can precede a guard decision, on MISS or HIT.
  //
  // PPR is opt-in per PAGE ROUTE via the `ppr` path option (read off the classified
  // route snapshot — the same matched entry match() will resolve). No `ppr` option
  // means pure axis 1: no store read, no capture, no logs, zero cost.
  //
  // On a valid HIT the composed response is committed HERE — the stored prelude
  // bytes flush immediately while match()/segment resolution/Flight render/resume
  // run behind them inside the response stream (ring-3 reads and render setup hide
  // behind wire bytes). On a MISS the request continues as plain axis 1 and a
  // background capture is scheduled after the response is built.
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
      // A per-request CSP nonce pins the route to axis 1: useNonce() (and any app
      // code reading the nonce) renders it into every nonced script/style/meta, so
      // a shell shared per host+URL would freeze one request's nonce for every
      // visitor and the browser's CSP would reject the frozen nonce for all but the
      // capture request. The nonce arrives two ways and BOTH must gate: the
      // createRouter({ nonce }) provider (threaded here as `nonce`), and a direct
      // token write in middleware (ctx.set(nonce, value)). The token is only
      // visible in the post-middleware request variables — and this commit point
      // runs AFTER the whole middleware chain (see the block header), so it is
      // present here. Reading it closes the gap the provider-only check left open
      // (issue #656). The threaded-param check stays first: the provider path is
      // resolved before any variable read and short-circuits cheaply.
      const activeNonce = nonce ?? contextGet(reqCtx._variables, nonceToken);
      const store = reqCtx._cacheStore;
      const key = buildShellKey(url);
      // Dev Server-Timing mirror (issue #651): a capture runs AFTER its
      // triggering response committed, so its outcome can only ride a LATER
      // response's header. When the metrics surface is active
      // (debugPerformance), fold the buffered terminal capture event for this
      // key into THIS request's Server-Timing as `ppr-capture;dur=<attempt
      // ms>;desc="<outcome + sizes + waits>"`. Consuming (read-and-clear)
      // keeps one capture = one report. Dev-only: the buffer is only written
      // in dev (see takeCaptureDebugEventForTiming), and production folds the
      // whole branch away.
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
          // store MISS (or an invalid/corrupt runtime entry), a Prerender+ppr
          // route's shell was already produced at `vite build` — serve it
          // through the SAME serveShellHit, so the first-ever request after a
          // deploy is a HIT with zero runtime capture. lookupBuildShell owns
          // every gate (search-less request, versions, integrity, tag
          // markers) and fails to null — the ordinary MISS path below takes
          // over. Past ppr.ttl the baked entry still serves but a runtime
          // recapture is scheduled: SWR is the UPGRADE path from build entry
          // to fresher runtime entry (the runtime store read above wins once
          // the capture lands).
          const buildHit = await lookupBuildShell(
            url,
            ctx.version,
            store,
            // Dev: no build manifest exists; producer B runs on demand via
            // the dev server's /__rsc_shell endpoint for PRERENDERED routes
            // only (production's exact candidate set). Folded away in
            // production builds (NODE_ENV is a compile-time constant).
            process.env.NODE_ENV !== "production"
              ? {
                  isPrerenderRoute:
                    reqCtx._classifiedRoute?.matched?.pr === true,
                  routeName: reqCtx._classifiedRoute?.routeKey,
                  ttl: pprConfig.ttl,
                  swr: pprConfig.swr,
                  tags: pprConfig.tags,
                  maxSnapshotBytes: pprConfig.maxSnapshotBytes,
                  captureTimeout: pprConfig.captureTimeout,
                }
              : undefined,
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
    const result = await ctx.router.matchPartial(request, { env });

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
  // The ppr route missed its shell above. Schedule the background capture only
  // when the served response is a 200 HTML document (a 404/error render is not a
  // cacheable shell), and tag the response for observability either way. Capture
  // does NOT flow through the HTTP pipeline: scheduleShellCapture re-derives the
  // page via router.match() under a derived context (fresh handle store,
  // _shellCaptureRun: true) — middleware never re-runs; it already ran for this
  // request and guarding is serve-time.
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
 * Neutralize the shell-HIT degradation redirect target.
 *
 * The inline `location.replace` emitted by serveShellHit when a shell HIT lands
 * on a URL whose route became redirecting mid-TTL is a document-native redirect
 * exit that BYPASSES the 3xx chokepoint (guardOutgoingRedirect acts only on 3xx
 * + Location responses, never a committed 200 body). So it reuses the ONE
 * same-origin resolver directly: a cross-origin/unparseable/unsafe target
 * neutralizes to the same safe same-origin landing as redirect-guard.ts
 * (basename root, or "/" when unset) rather than navigating the user off-host.
 * A safe same-origin/relative target passes through as its normalized href.
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
 * Serve a validated shell HIT: commit the composed response NOW — the stored
 * prelude bytes are the first thing on the wire — and run the live tail
 * (match(), fresh loaders, full Flight render for hydration, fizz resume of just
 * the holes) BEHIND them inside the response stream. React relies on HTML-parser
 * foster-parenting for content streamed after the prelude's closing
 * `</body></html>`, so plain byte concatenation is the correct composition.
 *
 * Status and headers are committed at the flush: middleware already ran (their
 * ctx.res headers merge in via createResponseWithMergedHeaders), and route
 * middleware code after its next() can still adjust headers on the returned
 * Response object. A failing hole cannot become a 500/redirect after this point —
 * error UI renders inline via Suspense/error boundaries, the documented PPR
 * constraint.
 *
 * The tail promise is kicked off SYNCHRONOUSLY so match/Flight/resume run inside
 * the current ALS request-context frame (the stream may be pulled by the server
 * adapter outside it).
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
    // Theme fidelity for resume: initialTheme is per-request METADATA (the
    // visitor's cookie), but React resume requires the tree above the holes to
    // match the frozen prelude, which was rendered with the CAPTURE's
    // initialTheme. Replay the captured value into the payload (the SSR resume
    // tree AND client hydration both read it) so the trees agree by
    // construction. The visitor still sees THEIR theme: the FOUC script in the
    // prelude applies it pre-paint from the cookie, and ThemeProvider re-syncs
    // its state from the cookie post-mount.
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
    // Capture data snapshot seeding (docs/design/ppr-shell-resume.md): the tail
    // is a FULL FRESH render whose payload must match the frozen prelude. If the
    // capture recorded a snapshot, run the tail through a SeededShellStore
    // overlay so every cache-store read the capture pinned returns its
    // capture-time value AS FRESH — the shell region reproduces byte-identically
    // even after the underlying cache entries drifted (expired/recomputed/
    // tag-invalidated). Everything not pinned (the holes — masked loaders were
    // never recorded) falls through to the real store and stays LIVE. The
    // overlay lives on a DERIVED context (own _cacheStore), so the shared reqCtx
    // is untouched; an entry without a snapshot keeps the pre-snapshot behavior.
    if (entry.snapshot && entry.snapshot.length > 0) {
      const seededCtx: RequestContext<any> = Object.create(reqCtx);
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
      // Shell fast path (serve side): when the capture recorded the implicit
      // doc segment record and the handler layer declared no liveness, arm the
      // implicit scope on the seeded context — the tail match's cache lookup
      // then HITs the SeededShellStore's doc entry and the whole handler layer
      // is REPLAYED, not re-executed (loaders still run fresh via
      // resolveFreshLoadersAndYield; per-request payload metadata is rebuilt
      // by buildFullPayload as always). A route with handler-live holes, a
      // route-derived cache scope, or a missing/corrupt record degrades to
      // the full tail (handler re-run — today's behavior) automatically.
      if (!entry.handlerLiveHoles) {
        seededCtx._shellImplicitCache = {
          ttl: descriptor.ttl,
          swr: descriptor.swr,
        };
        if (INTERNAL_RANGO_DEBUG) {
          console.log(
            `[Server][ppr] shell HIT: fast path armed (implicit doc cache) (abs ${Math.round(performance.now())})`,
          );
        }
      } else if (INTERNAL_RANGO_DEBUG) {
        console.log(
          `[Server][ppr] shell HIT: fast path declined — handler-live holes; tail re-runs handlers (abs ${Math.round(performance.now())})`,
        );
      }
      // Fragment splice (issue #700): cache/prerender-store hits inside THIS
      // tail render emit their stored segment fragments verbatim into the
      // payload; the SSR resume pass and browser hydration expand them
      // (segment-fragments.ts). Tail-only: the flag lives on the derived
      // context so it can never leak into a capture render (which serializes
      // segments and must see real elements).
      seededCtx._shellFragmentPayload = true;
      return runWithRequestContext(seededCtx, () => renderTail(seededCtx));
    }
    // No snapshot (e.g. a producer B entry whose capture hit only the
    // prerender store): still a shell-HIT tail, so arm the fragment splice on
    // a derived context — the tail's prerender-store/cache hits (if any) then
    // splice; a route with neither serves exactly as before. Derived, never
    // the shared reqCtx: scheduleShellCapture derives the capture context from
    // reqCtx and the flag must not be inherited there.
    const fragmentCtx: RequestContext<any> = Object.create(reqCtx);
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
        // Self-heal on a failed tail: the pre-commit gates (isValidShellHit +
        // hasIntactShellPayload) cannot catch a parseable-but-mismatched
        // postponed blob or a hard render error above the holes — those throw
        // here, AFTER the 200 + prelude flushed, and would otherwise re-fail on
        // every request until the entry ages out (nothing else evicts it).
        // Recapturing overwrites the entry with one the current server
        // produced. A client disconnect mid-stream also lands here and
        // schedules a spurious-but-idempotent recapture — bounded by the
        // stampede guard + backoff inside scheduleShellCapture.
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
