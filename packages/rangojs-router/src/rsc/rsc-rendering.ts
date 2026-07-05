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
import { getSSRSetup, isRscRequest } from "./ssr-setup.js";
import type { RscPayload } from "./types.js";
import type { SSRModule } from "./types.js";
import type { RequestContext } from "../server/request-context.js";
import {
  createResponseWithMergedHeaders,
  createSimpleRedirectResponse,
  attachLocationStateIfPresent,
} from "./helpers.js";
import type { HandlerContext } from "./handler-context.js";
import { gateTransitions } from "./transition-gate.js";
import { buildFullPayload } from "./full-payload.js";
import {
  scheduleShellCapture,
  type ShellCaptureDescriptor,
} from "./shell-capture.js";
import {
  SHELL_STATUS_HEADER,
  resolvePprConfig,
  buildShellKey,
  isValidShellHit,
  base64ToBytes,
  hasShellFamily,
  warnShellStoreMissingOnce,
  warnPprNonceActiveOnce,
} from "./shell-serve.js";
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
  return observePhase(PHASES.render, () =>
    handleRscRenderingInner(
      ctx,
      request,
      env,
      url,
      isPartial,
      handleStore,
      nonce,
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
    !isRscRequest(request, url, false)
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
            ttl: pprConfig.ttl,
            swr: pprConfig.swr,
            tags: pprConfig.tags,
            store,
            debug: INTERNAL_RANGO_DEBUG,
          };
          let cached: Awaited<ReturnType<typeof store.getShell>> = null;
          try {
            cached = await store.getShell(key);
          } catch (error) {
            // A failing store read degrades to axis 1 (MISS), never a 500.
            reportCacheError(error, "cache-read", "[ShellServe] getShell");
          }
          if (cached && isValidShellHit(cached.entry)) {
            // Stale (SWR) hit: serve the stale shell now, recapture in the
            // background (stampede-guarded + backoff inside scheduleShellCapture).
            if (cached.shouldRevalidate) {
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
              cached.entry,
            );
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
        // fetch, hitting the target without _rsc_partial.
        return createSimpleRedirectResponse(match.redirect);
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
    // render:total is recorded by the observePhase wrapper around this function.
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

  // ssr-render-html metric + rango.ssr span from one boundary. render:total is
  // recorded by the observePhase wrapper around this function.
  const htmlStream = await observePhase(PHASES.ssr, () =>
    ssrModule.renderHTML(rscStream, {
      nonce,
      streamMode,
    }),
  );
  const response = createResponseWithMergedHeaders(htmlStream, {
    headers: { "content-type": "text/html;charset=utf-8" },
  });

  // --- Axis 2: PPR shell CAPTURE on MISS (background task; see design doc) ---
  // The ppr route missed its shell above. Schedule the background capture only
  // when the served response is a 200 HTML document (a 404/error render is not a
  // cacheable shell), and tag the response for observability either way. Capture
  // does NOT flow through the HTTP pipeline: scheduleShellCapture re-derives the
  // page via router.match() under a derived context (fresh handle store,
  // _shellCaptureRun: true) — middleware never re-runs; it already ran for this
  // request and guarding is serve-time.
  if (pprMiss) {
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
): Response {
  const preludeBytes = base64ToBytes(entry.prelude);

  const renderTail = async (
    activeCtx: RequestContext<any>,
  ): Promise<ReadableStream<Uint8Array> | { redirect: string }> => {
    const match = await ctx.router.match(request, { env });
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
    const rscStream = ctx.renderToReadableStream<RscPayload>(payload, {
      onError: (error: unknown) => {
        ctx.callOnError(error, "rendering", { request, url, env });
      },
    });
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
      const loaderSeed = await buildShellLoaderSeed(entry.snapshot);
      if (loaderSeed) seededCtx._shellLoaderSeed = loaderSeed;
      return runWithRequestContext(seededCtx, () => renderTail(seededCtx));
    }
    return renderTail(reqCtx);
  })();
  // The stream below is the only consumer; pre-attach a no-op catch so a tail
  // failure before the stream is pulled never surfaces as an unhandled rejection.
  tailPromise.catch(() => {});

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(preludeBytes);
      try {
        const tail = await tailPromise;
        if (tail instanceof ReadableStream) {
          const reader = tail.getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              controller.enqueue(value);
            }
          } finally {
            reader.releaseLock();
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
        }
        controller.close();
      } catch (error) {
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
