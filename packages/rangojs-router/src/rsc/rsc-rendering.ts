/**
 * RSC Rendering Handler (Navigation)
 *
 * Handles RSC rendering for both partial (client-side navigation) and full
 * (initial page load) requests.
 */

import { requestHeaders } from "../server/request-headers.js";
import {
  getRequestContext,
  setRequestContextParams,
  runWithRequestContext,
  wireRenderBarrier,
} from "../server/request-context.js";
import {
  SeededShellStore,
  ShellRecordUnavailableError,
  buildShellLoaderSeed,
  countSnapshotFamilies,
  hasDocRecord,
  shellPrerenderHandles,
} from "../cache/shell-snapshot.js";
import { appendMetric } from "../router/metrics.js";
import type { MetricsStore } from "../server/context.js";
import { observePhase, PHASES } from "../router/instrument.js";
import type { TraceSpan } from "../router/tracing.js";
import { getSSRSetup, createSsrHtmlStage, isRscRequest } from "./ssr-setup.js";
import type { RscPayload } from "./types.js";
import type { SSRModule } from "./types.js";
import type { RequestContext } from "../server/request-context.js";
import type { PprReplayBypassReason } from "./shell-capture-constants.js";
import {
  createResponseWithMergedHeaders,
  createSimpleRedirectResponse,
  attachLocationStateIfPresent,
  matchAndRecordParams,
} from "./helpers.js";
import {
  createRenderStageTraceBridge,
  renderRscFlightStage,
  renderRscResponse,
} from "./render-pipeline.js";
import {
  createRoutineTrace,
  handoff,
  runRoutine,
  scope,
  step,
  type RoutinePlan,
} from "./routine-plan.js";
import type { HandlerContext } from "./handler-context.js";
import { attachTransitionWhen } from "./attach-transition-when.js";
import { publicRouteName } from "../route-name.js";
import { buildFullPayload } from "./full-payload.js";
import {
  capShellWindow,
  lastStoredCaptureSeq,
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
  shellSearchSeed,
  isValidShellHit,
  hasIntactShellPayload,
  openShellDocument,
  navigationShellKey,
  partitionShellKey,
  inlineShellScript,
  shellReloadScript,
  partitionBuildShellCheckDone,
  notePartitionBuildShellCheck,
  warnPprWindowCappedOnce,
  SHELL_PRELUDE_CHUNK_BYTES,
  hasShellFamily,
  warnShellStoreMissingOnce,
  warnPprNonceActiveOnce,
  describeShellTailTiming,
  publishShellTailTiming,
  takeShellTailTimingForServerTiming,
  type ResolvedPprConfig,
  type ShellDocument,
  type ShellTailTiming,
} from "./shell-serve.js";
import {
  hasBuildShell,
  lookupBuildShell,
  type DevShellLookup,
} from "./shell-build-manifest.js";
import { contextGet } from "../context-var.js";
import {
  isWarmReplace,
  noteWarmShellEvent,
} from "../prerender/warm-request.js";
import {
  resolveSwrWindow,
  staleShellRecaptureDue,
} from "../cache/cache-policy.js";
import {
  getNavigationContextHeader,
  prerenderStoreShortCircuits,
} from "../router/navigation-snapshot.js";
import {
  ensureFullRouteSnapshot,
  type RouteSnapshot,
} from "../router/route-snapshot.js";
import { prerenderEntryExists } from "../router/match-middleware/cache-lookup.js";
import {
  resolveSameOriginRedirect,
  safeSameOriginLanding,
} from "../redirect-origin.js";
import { nonce as nonceToken } from "./nonce.js";
import { escapeJsonForScript } from "../escape-script.js";
import { resolveShellPartition } from "../cache/cache-scope.js";
import { reportCacheError } from "../cache/cache-error.js";
import type { SearchParamsFilter } from "../cache/search-params-filter.js";
import { INTERNAL_RANGO_DEBUG } from "../internal-debug.js";
import type {
  SegmentCacheStore,
  ShellCacheEntry,
  ShellDocumentRead,
  ShellEntryHead,
  ShellReadStats,
  ShellSnapshotRecord,
} from "../cache/types.js";
import {
  SEGMENT_FRAGMENT_CAPABILITY_HEADER,
  SEGMENT_FRAGMENT_RECOVERY_HEADER,
} from "../segment-fragments.js";

type PprReplayStatus =
  | { outcome: "HIT"; freshness: "fresh" | "stale" }
  | { outcome: "BYPASS"; reason: PprReplayBypassReason };

type ShellReplayDecision =
  | { snapshot: ShellSnapshotRecord[] }
  | { reason: PprReplayBypassReason };

function serializePprReplayStatus(status: PprReplayStatus): string {
  return status.outcome === "HIT"
    ? `HIT; freshness=${status.freshness}`
    : `BYPASS; reason=${status.reason}`;
}

function describePprReplayStatus(status: PprReplayStatus): string {
  return status.outcome === "HIT"
    ? status.freshness
    : `bypass:${status.reason}`;
}

function createShellCaptureDescriptor(
  ctx: HandlerContext<any>,
  key: string,
  searchSeed: string,
  originSeed: string,
  pprConfig: ResolvedPprConfig,
  store: SegmentCacheStore<any>,
  navigationOnly?: true,
): ShellCaptureDescriptor {
  return {
    key,
    searchSeed,
    // Derived from the same request URL as the key (the callers compute
    // both next to each other, so they cannot drift): seeding the origin
    // keeps origin-dependent static markup (Link's data-external)
    // identical across capture, resume, and browser hydration.
    originSeed,
    buildVersion: ctx.version,
    ttl: pprConfig.ttl,
    swr: pprConfig.swr,
    tags: pprConfig.tags,
    captureTimeout: pprConfig.captureTimeout,
    store,
    maxSnapshotBytes: pprConfig.maxSnapshotBytes,
    debugSink: resolveShellCaptureDebugSink(ctx.router.debugShellCapture),
    navigationOnly,
  };
}

function shouldHealReplayMiss(
  reason: PprReplayBypassReason | undefined,
): boolean {
  return (
    reason === undefined ||
    reason === "invalid-version" ||
    reason === "corrupt-entry"
  );
}

/**
 * Post-match truth override for a pre-match BYPASS classification. The gate
 * decides before matchPartial runs, but two facts only the match can settle:
 * whether the prerender store ACTUALLY served (either artifact variant — the
 * gate's probe reads only the non-intercept one), and whether the navigation
 * resolved to an intercept (findInterceptForRoute runs during the match; the
 * intercept-source header proves nothing in either direction). The resulting
 * reason is stamped on the request context by withCacheLookup. A replay HIT is
 * never overridden — the seeded record was demonstrably consumed, so neither
 * fact can be true.
 */
function reclassifyReplayStatus(
  reqCtx: RequestContext<any>,
  status: PprReplayStatus,
): PprReplayStatus {
  if (status.outcome === "HIT") return status;
  const reason = reqCtx._pprReplayPostMatchReason;
  return reason ? { outcome: "BYPASS", reason } : status;
}

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
  entry: ShellCacheEntry,
  buildVersion: string,
): ShellReplayDecision {
  if (!isValidShellHit(entry, buildVersion)) {
    return { reason: "invalid-version" };
  }
  // navigationOnly entries store no document half (prelude/postponed absent),
  // so the payload gate applies to document-snapshot entries alone. Replay
  // consumes only the snapshot; fragment corruption inside it is caught by the
  // consumer-side Flight decoders (SegmentFragmentDecodeError →
  // segmentReplayCorrupt → healing capture at the document key).
  if (!entry.navigationOnly && !hasIntactShellPayload(entry)) {
    return { reason: "corrupt-entry" };
  }
  // Eligibility requires the CANONICAL doc segment record (`docKey`): replay
  // resolves that record and nothing else. An entry without it (a
  // prerender-served capture, a tombstone) reads as no-segment-snapshot.
  return hasDocRecord(entry.snapshot, entry.docKey)
    ? { snapshot: entry.snapshot }
    : { reason: "no-segment-snapshot" };
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

interface RequestRenderInput<TEnv> {
  ctx: HandlerContext<TEnv>;
  request: Request;
  env: TEnv;
  url: URL;
  isPartial: boolean;
  handleStore: ReturnType<typeof getRequestContext>["_handleStore"];
  nonce: string | undefined;
  renderSpan: TraceSpan;
  reqCtx: ReturnType<typeof getRequestContext>;
}

type ShellServeOutcome =
  | { kind: "serve"; response: Response }
  | { kind: "miss"; descriptor: ShellCaptureDescriptor; ssrModule: SSRModule }
  | { kind: "pass" };

type PreparedRender =
  | { kind: "control"; response: Response }
  | {
      kind: "payload";
      payload: RscPayload;
      /** The response depends on the source page: an intercept targets the route. */
      sourceScoped: boolean;
      pprReplayStatus?: PprReplayStatus;
      /** The key a navigation-only heal capture stores under, when one is needed. */
      healKey?: string;
    };

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
  // Flow trace rides the internal debug surface (INTERNAL_RANGO_DEBUG=1): the
  // Vite pipeline bakes the flag at build/dev-server start (inject-client-debug),
  // so trace allocation and output fold out of ordinary production builds while
  // an explicit debug build keeps them. The routine itself remains the executor.
  const mode = isPartial ? "partial" : "document";
  const trace = INTERNAL_RANGO_DEBUG ? createRoutineTrace(mode) : undefined;
  const reqCtx = getRequestContext();
  const input: RequestRenderInput<TEnv> = {
    ctx,
    request,
    env,
    url,
    isPartial,
    handleStore,
    nonce,
    renderSpan,
    reqCtx,
  };
  try {
    return await runRoutine(requestRenderPlan(input), {
      trace,
      owner: reqCtx,
    });
  } finally {
    if (trace) {
      console.log(
        `[routine] ${request.method} ${url.pathname} (${trace.name})\n${trace.format()}`,
      );
    }
  }
}

/**
 * The request-level render plan. Reads top to bottom as the request executes:
 * serve a stored PPR shell if one commits, otherwise match and build the
 * payload, render it through the stage driver, then hand off background
 * captures. Effects run through the routine runner (yield-before-execute,
 * exact result/error identity — see routine-plan.ts).
 */
function* requestRenderPlan<TEnv>(
  input: RequestRenderInput<TEnv>,
): RoutinePlan<Response> {
  const { isPartial, reqCtx } = input;

  // --- Axis 2: integrated PPR shell serve (docs/design/ppr-shell-resume.md) ---
  //
  // COMMIT POINT: this render pass runs strictly AFTER the whole middleware
  // chain (executeRender wraps it), so no shell byte can precede a guard
  // decision — that ordering is what makes a shared shell safe. Routes
  // without the `ppr` option stay pure axis 1 at zero cost.
  const shell = yield* scope("shell-serve", shellServePlan(input));
  if (shell.kind === "serve") return shell.response;

  // Match + payload. A control response (redirect) ends the plan before any
  // rendering.
  const prepared = yield* scope(
    isPartial ? "prepare:partial" : "prepare:full",
    preparePayloadPlan(input),
  );
  if (prepared.kind === "control") return prepared.response;

  // For partial requests, include any server-set location state in the payload.
  // SSR (full page) requests ignore location state since there's no history.state
  // to write to on a fresh page load.
  if (isPartial && prepared.payload.metadata) {
    attachLocationStateIfPresent(prepared.payload);
  }

  const response = yield* step("render", () =>
    renderPreparedRscResponse(input, prepared),
  );

  // --- Axis 2: PPR shell CAPTURE on MISS (background task; see design doc) ---
  // Capture only a 200 HTML document (a 404/error render is not a cacheable
  // shell). Capture does not flow through the HTTP pipeline — middleware never
  // re-runs (it already ran for this request; guarding is serve-time).
  // reqCtx._dynamic is re-read here on purpose: a loader may have marked the
  // request dynamic while rendering.
  if (shell.kind === "miss" && !reqCtx._dynamic) {
    if (
      response.status === 200 &&
      (response.headers.get("content-type") ?? "").includes("text/html")
    ) {
      const { descriptor, ssrModule } = shell;
      yield* handoff("shell-capture", () =>
        scheduleShellCapture(
          input.ctx,
          input.request,
          input.env,
          input.url,
          reqCtx,
          ssrModule,
          descriptor,
        ),
      );
    }
    response.headers.set(SHELL_STATUS_HEADER, "MISS");
  }

  const healKey = prepared.healKey;
  if (
    isPartial &&
    healKey !== undefined &&
    !reqCtx._dynamic &&
    response.status === 200
  ) {
    yield* handoff("navigation-shell-capture", () =>
      scheduleNavigationShellCapture(input, healKey),
    );
  }

  return response;
}

/**
 * Dev: warn once per route when the route's cache() entry reduces an explicit
 * ppr window. The window is what capShellWindow gives a capture from a
 * record written just now, the widest it can get; null (a cache() ttl + swr
 * of 0) is the capture's own warning.
 */
function warnIfPprWindowReduced(
  routeName: string,
  pprOption: { ttl?: number; swr?: number },
  pprConfig: ResolvedPprConfig,
  cacheScope: { ttl: number; swr: number | undefined },
  store: SegmentCacheStore<any>,
): void {
  const cache = { ttl: cacheScope.ttl, swr: cacheScope.swr ?? 0 };
  const shell = capShellWindow(
    pprConfig.ttl,
    resolveSwrWindow(pprConfig.swr, store.defaults),
    {
      freshUntil: cache.ttl * 1000,
      staleUntil: (cache.ttl + cache.swr) * 1000,
    },
    0,
  );
  if (shell) warnPprWindowCappedOnce(routeName, pprOption, shell, cache);
}

/**
 * Axis 2 shell serve. Sync gates stay plan code; store and SSR effects run as
 * named steps. Outcomes: serve a composed shell response, report a MISS (the
 * top-level plan schedules the capture after the response commits), or pass
 * (route not eligible — pure axis 1).
 */
function* shellServePlan<TEnv>(
  input: RequestRenderInput<TEnv>,
): RoutinePlan<ShellServeOutcome> {
  const { ctx, request, env, url, isPartial, handleStore, nonce, reqCtx } =
    input;
  const manifestEntry = reqCtx._classifiedRoute?.manifestEntry;

  // A router.prerender() warm (prerender/warm-request.ts) reports the shell of
  // a ppr route: "not-eligible" stands for every gate below that passes, until
  // a HIT or a capture event overwrites it.
  const warm = reqCtx._prerenderWarm;
  if (warm && resolvePprConfig(manifestEntry)) warm.shell ??= "not-eligible";

  if (
    isPartial ||
    request.method !== "GET" ||
    isRscRequest(request, url, false) ||
    reqCtx._dynamic
  ) {
    return { kind: "pass" };
  }
  const pprConfig = resolvePprConfig(manifestEntry);
  if (!pprConfig) return { kind: "pass" };
  // In replace mode the request is a MISS without reading a shell, and its
  // capture is forced (ShellCaptureDescriptor.force).
  const warmReplace = isWarmReplace(reqCtx);
  // A degraded HIT's reload (shellReloadScript) renders like a cache miss:
  // no shell read, no capture, so it can never degrade again. The handler
  // stripped the marker from the request and left this flag.
  if (reqCtx._shellForcedMiss) return { kind: "pass" };

  // A per-request CSP nonce pins the route to axis 1: a shared shell would
  // freeze the capture request's nonce and CSP would reject it for every
  // other visitor. Every step below, a HIT included, therefore runs without
  // one.
  const store = reqCtx._cacheStore;
  const baseKey = buildShellKey(ctx.router.id, url, reqCtx._searchParamsFilter);
  if (activeRequestNonce(nonce, reqCtx) !== undefined) {
    // Declared intent that cannot be honored deserves a diagnostic (unlike an
    // undeclared route, which is silent): a ppr route gated off by an active
    // per-request nonce warns once per key. Axis 1 after the warning.
    warnPprNonceActiveOnce(baseKey);
    return { kind: "pass" };
  }
  if (!hasShellFamily(store)) {
    // Declared intent that cannot be honored deserves a diagnostic (unlike an
    // undeclared route, which is silent). Axis 1 after the warning.
    warnShellStoreMissingOnce(baseKey);
    return { kind: "pass" };
  }
  // The route's own cache() opt-out — cache(false), or a condition() that
  // refuses THIS request — is absolute, and a HIT tail never consults the
  // route scope (it replays the shell's doc record), so it is decided here,
  // before any shell byte: the request renders like a cache miss (axis 1) and
  // schedules no capture (the capture could not record the handler layer).
  const route = classifiedRouteSnapshot(reqCtx);
  if (route?.cacheScope && !route.cacheScope.allowsCache("read")) {
    return { kind: "pass" };
  }
  // The shell is capped to the route cache() entry it captures from
  // (capShellWindow); an explicit ppr window the cap reduces warns in dev.
  // resolvePprConfig returned a config, so the entry is a ppr route.
  const pprOption = manifestEntry?.type === "route" && manifestEntry.ppr;
  if (
    process.env.NODE_ENV !== "production" &&
    route?.cacheScope?.enabled &&
    typeof pprOption === "object" &&
    (pprOption.ttl !== undefined || pprOption.swr !== undefined)
  ) {
    warnIfPprWindowReduced(
      reqCtx._classifiedRoute?.routeKey ?? url.pathname,
      pprOption,
      pprConfig,
      route.cacheScope,
      store,
    );
  }
  // A route whose cache() record is partitioned by the request (its `key()`,
  // or the store's keyGenerator) partitions its shell the same way: each
  // partition captures and serves its own shell. A failed key resolution
  // serves no shell, never another partition's.
  const requestKey = resolveRequestShellKey(
    baseKey,
    route,
    store,
    reqCtx,
    "ShellServe",
  );
  const key =
    typeof requestKey === "string"
      ? requestKey
      : yield* step("shell-partition", () => requestKey);
  if (key === undefined) return { kind: "pass" };
  reqCtx._shellKey = key;
  // The buffered capture and tail timings are keyed by the partitioned key.
  mirrorPprServerTimings(key, reqCtx);

  // A MISS schedules its capture after rendering: taken before the read, this
  // lets that capture skip itself when another request's capture stored the
  // shell in between (ShellCaptureDescriptor.storedSeqAtRead).
  // A warm's capture is its own: one another request stored meanwhile does
  // not cancel it, so it takes no sequence.
  const storedSeqAtRead = warmReplace ? undefined : lastStoredCaptureSeq(key);
  // SSR setup starts before route handling, so read the shell before joining it
  // to overlap the remaining setup work with cache I/O.
  const cached = warmReplace
    ? null
    : yield* step("shell-read", () =>
        readShellEntry(store, key, reqCtx, pprConfig.tags),
      );

  // allReady (ssr.resolveStreaming) bypasses PPR entirely: buffering defeats
  // streaming, so bots/SEO crawlers get one complete axis-1 document. These
  // routes pay one unnecessary shell read to keep the PPR hot path concurrent.
  const [ssrModule, streamMode] = yield* step("ssr-setup", () =>
    getSSRSetup(ctx, request, env, url, reqCtx._metricsStore),
  );
  if (
    streamMode === "allReady" ||
    !ssrModule.resumeShellHTML ||
    !ssrModule.captureShellHTML
  ) {
    return { kind: "pass" };
  }
  const descriptor = createShellCaptureDescriptor(
    ctx,
    key,
    shellSearchSeed(url, reqCtx._searchParamsFilter),
    url.origin,
    pprConfig,
    store,
  );
  if (warm) {
    // The warm learns its capture's outcome from the capture's own events,
    // ahead of the router's debugShellCapture sink.
    const routerSink = descriptor.debugSink;
    descriptor.debugSink = (event) => {
      noteWarmShellEvent(warm, event);
      routerSink?.(event);
    };
  }
  // MISS (no entry, invalid reactVersion, a tombstone, or store read
  // failure): axis 1 + a background capture scheduled once the response is
  // known servable.
  const miss: ShellServeOutcome = {
    kind: "miss",
    descriptor: { ...descriptor, storedSeqAtRead },
    ssrModule,
  };
  // Neither the stored shell nor the build shell is read: a warm renders.
  if (warmReplace) {
    return { ...miss, descriptor: { ...descriptor, force: true } };
  }

  // A HIT replays the handler layer from the entry's doc record (`docKey`),
  // or, for a Prerender route, from the prerender store. An entry that has
  // neither is a MISS: serving it would run handlers after the commit.
  if (
    cached &&
    !cached.entry.navigationOnly &&
    (cached.entry.docKey !== undefined || route?.matched?.pr === true) &&
    isValidShellHit(cached.entry, ctx.version)
  ) {
    const document = openShellDocumentMetered(reqCtx, cached);
    if (!document) {
      // Corrupt stored payload (undecodable prelude / unparseable
      // postponed): a store-layer fault worth a diagnostic, unlike the
      // silent version-mismatch lifecycle misses above. Degrade to MISS
      // — the top-level plan schedules the recapture that overwrites it.
      reportCacheError(
        new Error(
          `corrupt shell entry for "${key}": prelude/postponed failed ` +
            "the integrity check; serving axis 1 and recapturing",
        ),
        "cache-read",
        "[ShellServe] getShell",
      );
    } else {
      // An onlyIfStale warm found a servable shell; a recapture scheduled
      // below overwrites this through the capture's events.
      if (warm) warm.shell = "fresh";
      // Stale (SWR) hit: serve the stale shell now, recapture in the
      // background (stampede-guarded + backoff inside scheduleShellCapture),
      // at most once per SHELL_MIN_RECAPTURE_INTERVAL_MS of the shell's age.
      if (
        cached.shouldRevalidate &&
        staleShellRecaptureDue(cached.entry, Date.now())
      ) {
        yield* handoff("shell-recapture", () =>
          scheduleShellCapture(
            ctx,
            request,
            env,
            url,
            reqCtx,
            ssrModule,
            descriptor,
          ),
        );
      }
      const response = yield* step("shell-hit", () =>
        serveShellHit(
          ctx,
          request,
          env,
          url,
          reqCtx,
          handleStore,
          ssrModule,
          document,
          descriptor,
        ),
      );
      return { kind: "serve", response };
    }
  }

  // A runtime tombstone (degradeUnreplayableShell: this key's HIT could not
  // replay its handler layer) shadows the build shell too, or a build shell
  // whose tail cannot be replayed would degrade on every request until a
  // runtime capture lands.
  if (
    cached?.entry.navigationOnly &&
    isValidShellHit(cached.entry, ctx.version)
  ) {
    return miss;
  }

  // Build-time shell read-through (producer B, #699): on a runtime
  // store MISS a Prerender+ppr route serves its `vite build`-baked
  // shell through the SAME serve path. A partitioned route has none: the
  // build captured one partition, which no request may be assumed to
  // share, and a route that has a build shell says so once. lookupBuildShell
  // owns the validity gates and fails to null; openShellDocument below is
  // the prelude's integrity check and only decode (either failing leaves the
  // ordinary MISS path); past ppr.ttl the baked entry still serves while SWR
  // recaptures — the upgrade path from build entry to runtime entry.
  //
  // Dev: no build manifest exists; producer B runs on demand via the dev
  // server's /__rsc_shell endpoint for PRERENDERED routes only (production's
  // exact candidate set). Folded away in production builds (NODE_ENV is a
  // compile-time constant).
  const devShellLookup = resolveDevShellLookup(reqCtx, pprConfig);
  let buildHit: Awaited<ReturnType<typeof lookupBuildShell>> = null;
  if (key !== baseKey) {
    // Probed once per path without a build shell, and not again once the
    // route warned. A search-bearing URL never reads one: nothing to probe.
    const routeName = reqCtx._classifiedRoute?.routeKey;
    if (
      !partitionBuildShellCheckDone(url.pathname, routeName) &&
      shellSearchSeed(url, reqCtx._searchParamsFilter) === ""
    ) {
      const found = yield* step("build-shell-check", () =>
        hasBuildShell(ctx.router.id, url.pathname, devShellLookup),
      );
      notePartitionBuildShellCheck(url.pathname, routeName, found);
    }
  } else {
    buildHit = yield* step("build-shell-lookup", () =>
      lookupBuildShell(
        ctx.router.id,
        url,
        ctx.version,
        store,
        devShellLookup,
        reqCtx._searchParamsFilter,
      ),
    );
  }
  // The document serve decodes the baked prelude once here; an undecodable
  // one is a MISS like a corrupt runtime entry.
  const buildDocument = buildHit
    ? openShellDocumentMetered(reqCtx, { entry: buildHit.entry })
    : null;
  if (buildHit && buildDocument) {
    if (warm) warm.shell = "fresh";
    // Past ppr.ttl: still serve the baked entry, recapture upgrades it.
    if (buildHit.stale) {
      yield* handoff("shell-recapture", () =>
        scheduleShellCapture(
          ctx,
          request,
          env,
          url,
          reqCtx,
          ssrModule,
          descriptor,
        ),
      );
    }
    const response = yield* step("shell-hit", () =>
      serveShellHit(
        ctx,
        request,
        env,
        url,
        reqCtx,
        handleStore,
        ssrModule,
        buildDocument,
        descriptor,
      ),
    );
    return { kind: "serve", response };
  }

  return miss;
}

/**
 * Match the request and assemble the RSC payload, or produce a control
 * response (redirect) that ends the request plan.
 */
function* preparePayloadPlan<TEnv>(
  input: RequestRenderInput<TEnv>,
): RoutinePlan<PreparedRender> {
  const { ctx, request, env, url, isPartial, handleStore, nonce, reqCtx } =
    input;

  if (isPartial) {
    // Partial render (navigation)
    const replay = yield* step("match:ppr-replay", () =>
      matchPartialAndRecordParams(ctx, request, env, url, reqCtx, nonce),
    );
    const result = replay.result;
    const pprReplayStatus = replay.status;
    const healKey = "healKey" in replay ? replay.healKey : undefined;

    if (!result) {
      // Fall back to full render
      const match = yield* step("match:fallback", () =>
        matchAndRecordParams(ctx, request, env),
      );

      if (match.redirect) {
        // Partial request: use X-RSC-Redirect header so the client can
        // perform SPA navigation. A raw 308 would be auto-followed by
        // fetch, hitting the target without _rsc_partial. Resolve the
        // target server-side (same open-redirect policy as 3xx).
        const redirectResponse = createSimpleRedirectResponse(match.redirect, {
          requestOrigin: url.origin,
          basename: ctx.router.basename,
        });
        if (pprReplayStatus) {
          redirectResponse.headers.set(
            PPR_REPLAY_STATUS_HEADER,
            serializePprReplayStatus(pprReplayStatus),
          );
        }
        return { kind: "control", response: redirectResponse };
      }

      return {
        kind: "payload",
        payload: buildFullPayload(match, ctx, url, reqCtx, handleStore),
        sourceScoped: false,
        pprReplayStatus,
        healKey,
      };
    }

    return {
      kind: "payload",
      payload: {
        metadata: {
          pathname: url.pathname,
          // routerId is serialized on every payload (including within-session
          // ones) so the frontend can read the current app/router identity. It
          // always equals the current app's id: a cross-app navigation is
          // intercepted server-side (X-RSC-Reload) and never delivers a
          // different-router payload to the client.
          routerId: ctx.router.id,
          segments: attachTransitionWhen(result.segments, reqCtx),
          matched: result.matched,
          diff: result.diff,
          resolvedIds: result.resolvedIds,
          params: result.params,
          routeName: publicRouteName(result.routeName),
          isPartial: true,
          slots: result.slots,
          interceptTargets: result.interceptTargets,
          handles: handleStore.stream(),
          version: ctx.version,
          prefetchCacheTTL: ctx.router.prefetchCacheTTL,
          prefetchCacheSize: ctx.router.prefetchCacheSize,
          prefetchConcurrency: ctx.router.prefetchConcurrency,
          defaultPrefetch: ctx.router.defaultPrefetch,
          stateCookieName: ctx.router.resolvedStateCookieName,
        },
      },
      sourceScoped: result.interceptTargeted === true,
      pprReplayStatus,
      healKey,
    };
  }

  // Full render (initial page load)
  const match = yield* step("match", () =>
    matchAndRecordParams(ctx, request, env),
  );

  if (match.redirect) {
    return {
      kind: "control",
      response: createResponseWithMergedHeaders(null, {
        status: 308,
        headers: { Location: match.redirect },
      }),
    };
  }

  return {
    kind: "payload",
    payload: buildFullPayload(match, ctx, url, reqCtx, handleStore),
    sourceScoped: false,
  };
}

/**
 * PPR replay match that stamps params/routeName when a replay result exists.
 * A null result records nothing — the fallback match records its own.
 */
async function matchPartialAndRecordParams<TEnv>(
  ctx: HandlerContext<TEnv>,
  request: Request,
  env: TEnv,
  url: URL,
  reqCtx: RequestContext<any>,
  nonce: string | undefined,
): Promise<Awaited<ReturnType<typeof matchPartialWithPprReplay<TEnv>>>> {
  const replay = await matchPartialWithPprReplay(
    ctx,
    request,
    env,
    url,
    reqCtx,
    nonce,
  );
  if (replay.result) {
    setRequestContextParams(replay.result.params, replay.result.routeName);
  }
  return replay;
}

/**
 * A document serve's store read: a getShell entry, or a prelude-first read
 * (readShellDocument) whose entry is the head and whose snapshot arrives on
 * its own promise.
 */
type ShellStoreRead =
  | { entry: ShellCacheEntry; shouldRevalidate?: boolean; read?: undefined }
  | {
      entry: ShellEntryHead;
      shouldRevalidate?: boolean;
      read: ShellDocumentRead;
    };

/**
 * Shell store read that degrades to null on failure (axis 1 MISS, never a 500)
 * and records the raw `ppr:shell-read` outcome (pre-validity-gates, so a
 * version-mismatch lifecycle miss stays distinguishable from a store miss).
 * A store with a prelude-first read (readShellDocument) resolves before the
 * snapshot is read, so the HIT commits without waiting for it.
 */
async function readShellEntry(
  store: SegmentCacheStore & {
    getShell: NonNullable<SegmentCacheStore["getShell"]>;
  },
  key: string,
  reqCtx: ReturnType<typeof getRequestContext>,
  tagHints: readonly string[] | undefined,
): Promise<ShellStoreRead | null> {
  let cached: ShellStoreRead | null = null;
  const shellReadStart = reqCtx._metricsStore ? performance.now() : 0;
  try {
    if (store.readShellDocument) {
      const read = await store.readShellDocument(
        key,
        tagHints ? { tagHints } : undefined,
      );
      cached = read
        ? { entry: read.entry, shouldRevalidate: read.shouldRevalidate, read }
        : null;
    } else {
      cached = await store.getShell(key);
    }
  } catch (error) {
    reportCacheError(error, "cache-read", "[ShellServe] getShell");
  }
  if (reqCtx._metricsStore) {
    const stats = cached?.read?.stats;
    appendMetric(
      reqCtx._metricsStore,
      "ppr:shell-read",
      shellReadStart,
      performance.now() - shellReadStart,
      undefined,
      cached ? (stats ? `hit ${stats.tier}` : "hit") : "miss",
    );
    if (stats)
      recordShellReadStats(reqCtx._metricsStore, shellReadStart, stats);
  }
  return cached;
}

/**
 * A prelude-first read's sub-steps as `debugPerformance` rows under
 * `ppr:shell-read`. The marker row starts with the prelude row because the
 * two run in parallel; its desc says how long the read still waited on the
 * marker once the prelude was in. On a deployed worker the clock only
 * advances on I/O, so the byte counts are the cost signal for the CPU parts.
 */
function recordShellReadStats(
  store: MetricsStore,
  readStart: number,
  stats: ShellReadStats,
): void {
  let at = readStart;
  const row = (label: string, ms: number | undefined, desc: string): void => {
    if (ms !== undefined) appendMetric(store, label, at, ms, 1, desc);
  };
  if (stats.memo) {
    row(
      "ppr:shell-memo",
      0,
      `${stats.memo.hit ? "hit" : "miss"} size=${stats.memo.bytes}b`,
    );
  }
  // A KV hit after an L1 miss: the L1 attempt first, then the KV read.
  row("ppr:shell-l1-miss", stats.l1MissMs, stats.l1MissReason ?? "miss");
  at += stats.l1MissMs ?? 0;
  row("ppr:shell-match", stats.matchMs, stats.tier);
  at += stats.matchMs ?? 0;
  row("ppr:shell-head", stats.headMs, `bytes=${stats.headBytes ?? 0}`);
  at += stats.headMs ?? 0;
  row("ppr:shell-prelude", stats.preludeMs, `bytes=${stats.preludeBytes ?? 0}`);
  let marker = `tags=${stats.tags ?? 0} ${stats.markerSerial ? "serial" : "parallel"} commit-wait=${(stats.markerWaitMs ?? 0).toFixed(2)}ms`;
  if (stats.markerMemo) marker += ` memo=${stats.markerMemo}`;
  if (stats.markerHinted) {
    marker += ` hint=${stats.markerHintHits ?? 0}/${stats.markerHinted.length}`;
    if (stats.markerLeadMs !== undefined) {
      marker += ` lead=${stats.markerLeadMs.toFixed(2)}ms`;
    }
  }
  if (stats.freshReads) marker += " fresh-reads";
  row("ppr:shell-marker", stats.markerMs, marker);
}

/**
 * openShellDocument (the HIT's integrity gate and only prelude decode) as a
 * `ppr:shell-open` row: CPU only, so it reads 0 on a deployed worker.
 */
function openShellDocumentMetered(
  reqCtx: RequestContext<any>,
  stored: ShellStoreRead,
): ShellDocument | null {
  const read = stored.read;
  const open = (): ShellDocument | null =>
    stored.read
      ? openShellDocument(stored.entry, stored.read)
      : openShellDocument(stored.entry);
  const store = reqCtx._metricsStore;
  if (!store) return open();
  const start = performance.now();
  const document = open();
  appendMetric(
    store,
    "ppr:shell-open",
    start,
    performance.now() - start,
    undefined,
    `cpu ${read ? "raw" : "base64-decode"} prelude=${document?.prelude.length ?? 0}b`,
  );
  return document;
}

/**
 * The request's per-request CSP nonce. BOTH sources count: the
 * createRouter({ nonce }) provider (`nonce`) and a middleware
 * ctx.set(nonce, …) token write; the provider-only check missed the latter
 * (issue #656). Read at the commit point, after the whole middleware chain.
 */
function activeRequestNonce(
  nonce: string | undefined,
  reqCtx: RequestContext<any>,
): string | undefined {
  return nonce ?? contextGet(reqCtx._variables, nonceToken);
}

/**
 * The shell key a request reads and captures: `baseKey`, partitioned by the
 * route's request partition (cache-scope.ts resolveShellPartition; a
 * partition equal to the default key leaves it unchanged). `baseKey` itself,
 * synchronously and with no work, when nothing partitions the route; else a
 * promise that resolves undefined when the key failed to resolve (reported
 * as `[source] shell key`): such a request reads and captures no shell,
 * never another partition's.
 */
function resolveRequestShellKey(
  baseKey: string,
  route: RouteSnapshot<any> | null,
  store: SegmentCacheStore,
  reqCtx: RequestContext<any>,
  source: string,
): string | Promise<string | undefined> {
  const partition = resolveShellPartition(
    route?.cacheScope,
    store,
    reqCtx.url.pathname,
    route?.params,
  );
  if (!partition) return baseKey;
  return partition.then(
    (resolved) =>
      resolved === null ? baseKey : partitionShellKey(baseKey, resolved),
    (error: unknown) => {
      reportCacheError(error, "cache-read", `[${source}] shell key`);
      return undefined;
    },
  );
}

/**
 * Observe the explicit-scope composition in withCacheLookup: the route's own
 * cache() scope served the request (`explicit-cache-hit`) or refused it at
 * lookup time (`cache-disabled`). The two are exclusive per lookup, and
 * neither fires when the seeded doc record served.
 */
function observeExplicitScope(): {
  onExplicitHit: () => void;
  onExplicitBypass: () => void;
  bypassed: () => boolean;
  status: (otherwise: PprReplayStatus) => PprReplayStatus;
} {
  let observed: "hit" | "bypass" | undefined;
  return {
    onExplicitHit: () => {
      observed = "hit";
    },
    onExplicitBypass: () => {
      observed = "bypass";
    },
    bypassed: () => observed === "bypass",
    status: (otherwise) =>
      observed === "hit"
        ? { outcome: "BYPASS", reason: "explicit-cache-hit" }
        : observed === "bypass"
          ? { outcome: "BYPASS", reason: "cache-disabled" }
          : otherwise,
  };
}

/**
 * Server-Timing mirror (issue #651): a capture or a HIT tail completes AFTER
 * its triggering response committed, so its numbers can only ride a LATER
 * response's header. Read-and-clear keeps one report per run. The capture
 * half is dev-only (see takeCaptureDebugEventForTiming); the tail half runs
 * wherever a tail was buffered (serveShellHit).
 */
function mirrorPprServerTimings(
  key: string,
  reqCtx: ReturnType<typeof getRequestContext>,
): void {
  if (!reqCtx._metricsStore) return;
  if (process.env.NODE_ENV !== "production") {
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
  }
  // Same mirror for the previous HIT's tail: its per-stage numbers
  // (snapshot/seed/match/handover/first-html/complete) finished after that
  // response's headers were committed, so they ride THIS request's
  // Server-Timing as `ppr:tail;dur=<complete ms>`. In production a tail is
  // buffered only when its own HIT collected metrics (serveShellHit).
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

/** Assemble headers + tracking and run the foreground stage-driver render. */
function renderPreparedRscResponse<TEnv>(
  input: RequestRenderInput<TEnv>,
  prepared: Extract<PreparedRender, { kind: "payload" }>,
): Promise<Response> {
  const { ctx, request, env, url, isPartial, nonce, reqCtx, renderSpan } =
    input;
  const { payload, pprReplayStatus, sourceScoped } = prepared;
  const metricsStore = reqCtx._metricsStore;

  const rscHeaders: Record<string, string> = {
    "content-type": "text/x-component;charset=utf-8",
    vary: `accept, X-Rango-State, X-RSC-Router-Client-Path, ${SEGMENT_FRAGMENT_CAPABILITY_HEADER}, ${SEGMENT_FRAGMENT_RECOVERY_HEADER}`,
    // Router identity, so the client can verify pre-decode (before importing
    // chunks) that this content payload belongs to its app and refuse a
    // foreign one (cache/proxy/bug). Control-only reload/redirect responses
    // are deliberately NOT stamped. See browser/response-adapter.ts.
    "X-RSC-Router-Id": ctx.router.id,
  };
  if (pprReplayStatus) {
    rscHeaders[PPR_REPLAY_STATUS_HEADER] =
      serializePprReplayStatus(pprReplayStatus);
  }
  // Tell the client's prefetch cache to scope this response to its source
  // URL (instead of the default source-agnostic wildcard). A route an
  // intercept targets renders the modal or the full page depending on the
  // source, so neither response may be reused from another source: a full
  // page prefetched where the intercept does not apply would otherwise
  // serve a later click where it does (#1007).
  if (sourceScoped) {
    rscHeaders["x-rsc-prefetch-scope"] = "source";
  }
  // Enable browser HTTP caching for prefetch responses only.
  // Requires X-Rango-Prefetch header (sent by Link prefetch fetch),
  // a source-agnostic response (see sourceScoped above), and a configured
  // cache-control value (false disables caching).
  const isPrefetch = requestHeaders(request).has("X-Rango-Prefetch");
  if (isPrefetch && isPartial && !sourceScoped) {
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
    onEvent:
      reqCtx._activeRoutine &&
      createRenderStageTraceBridge(reqCtx._activeRoutine),
  };
  return renderRscResponse(
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
}

/**
 * Background capture for a navigation-only shell (partial replay reported
 * captureNeeded). SSR setup is resolved lazily inside the capture because the
 * partial request itself never touched HTML rendering.
 */
function scheduleNavigationShellCapture<TEnv>(
  input: RequestRenderInput<TEnv>,
  captureKey: string,
): void {
  const { ctx, request, env, url, reqCtx } = input;
  const pprConfig = resolvePprConfig(reqCtx._classifiedRoute?.manifestEntry)!;
  const store = reqCtx._cacheStore!;
  scheduleShellCapture(
    ctx,
    request,
    env,
    url,
    reqCtx,
    async (captureRequest, captureUrl) => {
      const [ssrModule, streamMode] = await getSSRSetup(
        ctx,
        captureRequest,
        env,
        captureUrl,
        undefined,
      );
      return streamMode === "allReady" ? null : ssrModule;
    },
    createShellCaptureDescriptor(
      ctx,
      captureKey,
      shellSearchSeed(url, reqCtx._searchParamsFilter),
      url.origin,
      pprConfig,
      store,
      true,
    ),
  );
}

/**
 * Reuse a PPR capture's canonical segment record for a partial navigation.
 * The ordinary matchPartial pipeline remains authoritative: it projects the
 * cached target tree against the client's segment ids and evaluates
 * revalidation. Only the segment family is seeded into the store overlay, so
 * item and response reads stay live; a record that served also arms the
 * bake-lane loader pins (onHit), which serve as on a document HIT, while live
 * loaders run fresh.
 */
async function matchPartialWithPprReplay<TEnv>(
  ctx: HandlerContext<TEnv>,
  request: Request,
  env: TEnv,
  url: URL,
  reqCtx: RequestContext<any>,
  nonce: string | undefined,
) {
  const replayStart = reqCtx._metricsStore ? performance.now() : 0;
  const recordReplayStatus = (status: PprReplayStatus): void => {
    if (!reqCtx._metricsStore) return;
    appendMetric(
      reqCtx._metricsStore,
      "ppr:navigation-replay",
      replayStart,
      performance.now() - replayStart,
      undefined,
      describePprReplayStatus(status),
    );
  };
  const finalizeReplayStatus = (status: PprReplayStatus): PprReplayStatus => {
    const finalStatus = reclassifyReplayStatus(reqCtx, status);
    recordReplayStatus(finalStatus);
    return finalStatus;
  };
  let armFragments = false;
  /**
   * Every matchPartial in this function runs through this helper so the
   * fragment flag (#700 passthrough, armed below the navigation-context gate)
   * can never outlive a match or miss a lane — a thrown-Response redirect
   * exit included. Mutate-restore on the SHARED reqCtx, never a derived
   * context: the pipeline writes ambient state during the match that must
   * land on reqCtx (_pprReplayPostMatchReason, location state,
   * _treeHasStreaming read by the render-barrier closure). Assign-back
   * restore leaves an own `undefined` after the first arm, matching the
   * _shellImplicitCache idiom.
   */
  const matchPartialForReplay = async () => {
    if (!armFragments) return ctx.router.matchPartial(request, { env });
    const prevFragmentPayload = reqCtx._shellFragmentPayload;
    reqCtx._shellFragmentPayload = true;
    try {
      return await ctx.router.matchPartial(request, { env });
    } finally {
      reqCtx._shellFragmentPayload = prevFragmentPayload;
    }
  };
  const runMatch = async (status?: PprReplayStatus) => {
    const result = await matchPartialForReplay();
    // The match may have settled a fact the pre-match gate could only guess
    // at (prerender serve, intercept resolution) — report the truth.
    const finalStatus = status ? finalizeReplayStatus(status) : undefined;
    return { result, status: finalStatus };
  };
  const pprConfig = resolvePprConfig(reqCtx._classifiedRoute?.manifestEntry);
  const activeNonce = activeRequestNonce(nonce, reqCtx);
  const store = reqCtx._cacheStore;

  if (!pprConfig) return runMatch();
  if (request.method !== "GET") {
    return runMatch({ outcome: "BYPASS", reason: "method" });
  }
  if (reqCtx._dynamic) {
    return runMatch({ outcome: "BYPASS", reason: "dynamic" });
  }
  if (activeNonce !== undefined) {
    return runMatch({ outcome: "BYPASS", reason: "nonce" });
  }
  if (!hasShellFamily(store)) {
    return runMatch({ outcome: "BYPASS", reason: "store-unavailable" });
  }
  if (store.supportsPassiveShellReads !== true) {
    return runMatch({
      outcome: "BYPASS",
      reason: "passive-read-unsupported",
    });
  }
  // A partial without navigation context (curl probes, synthetic monitors)
  // can never produce a partial match — createMatchContextForPartial returns
  // null and the seeded record could not have been consulted, which used to
  // read as a misleading `snapshot-miss` AFTER two wasted getShell reads.
  // Same predicate as resolveNavigation, decided before any store I/O.
  if (!getNavigationContextHeader(request, url.origin)) {
    return runMatch({ outcome: "BYPASS", reason: "no-navigation-context" });
  }
  // Fragment passthrough (#700), extended to partial replay. Navigation
  // context proves the request can be matched; the separate capability header
  // proves its payload consumer can expand envelopes. Older clients and the
  // one-shot corruption recovery request still replay the same segment record,
  // but through the server decode path.
  armFragments =
    requestHeaders(request).get(SEGMENT_FRAGMENT_RECOVERY_HEADER) !== "1" &&
    requestHeaders(request).get(SEGMENT_FRAGMENT_CAPABILITY_HEADER) === "1";
  // The prerender probe and the cache-opt-out gate below both need the
  // classified snapshot; resolve (and persist) it once.
  const routeSnapshot = classifiedRouteSnapshot(reqCtx);
  // Prerender routes short-circuit in withCacheLookup and serve the partial
  // from build-time segments — a better-than-HIT outcome. Their captures
  // record no doc segment record (withCacheStore skips on the prerender hit),
  // so seeding could never succeed; skip the reads and report the store that
  // actually serves instead of blaming a "broken" capture. Bypass ONLY when
  // the baked artifact actually exists — the trie's pr flag alone is not a
  // serve guarantee: a Passthrough(Prerender()) route with an unbaked or
  // ctx.passthrough()-skipped param misses the store and renders live, and
  // replay (including its heal capture) must stay available for it. The
  // probe goes through the same memoized store the middleware serves from.
  // Shared predicate with the middleware (it declines on dev HMR — such
  // partials fall through to the ordinary replay decision here too).
  //
  // The probe is a PRE-match fast path, not the truth: it reads only the
  // non-intercept artifact, and whether the navigation IS an intercept (and
  // therefore whether tryPrerenderLookup reads `paramHash` or
  // `paramHash + "/i"`) is resolved during the match by match-api's
  // findInterceptForRoute — an intercept-source header proves nothing in
  // either direction. runMatch reclassifies every BYPASS from the stamped
  // post-match facts (reclassifyReplayStatus), so a wrong guess here can
  // skip the two getShell reads but never mis-report or mis-heal.
  if (
    prerenderStoreShortCircuits(routeSnapshot?.matched?.pr, request) &&
    (await prerenderEntryExists(
      routeSnapshot?.matched?.routeKey,
      routeSnapshot?.params ?? {},
      url.pathname,
      routeSnapshot?.entries ?? [],
    ))
  ) {
    return runMatch({ outcome: "BYPASS", reason: "prerender-store" });
  }
  // Consumer cache opt-outs are absolute: a STATICALLY disabled scope
  // (cache(false)) bypasses before any shell read — no heal capture (its
  // snapshot would be equally unusable). A `condition()` predicate is
  // request-time state and must NOT be pre-decided here: evaluating it at the
  // gate and again at the lookup lets a false-then-true flap report
  // cache-disabled while the explicit tier serves. The lookup's own
  // evaluation governs (withCacheLookup fires the marker's onExplicitBypass,
  // reported as cache-disabled post-match).
  const routeCacheScope = routeSnapshot?.cacheScope ?? null;
  if (routeCacheScope && !routeCacheScope.enabled) {
    return runMatch({ outcome: "BYPASS", reason: "cache-disabled" });
  }

  // The visitor's own partition (resolveShellPartition): replay never
  // crosses into another partition's shell.
  const key = await resolveRequestShellKey(
    buildShellKey(ctx.router.id, url, reqCtx._searchParamsFilter),
    routeSnapshot,
    store,
    reqCtx,
    "NavigationPPR",
  );
  if (key === undefined) {
    return runMatch({ outcome: "BYPASS", reason: "read-error" });
  }
  const navigationKey = navigationShellKey(key);
  let cached: Awaited<ReturnType<typeof store.getShell>> = null;
  try {
    cached = await store.getShell(key, { claimRevalidation: false });
  } catch (error) {
    reportCacheError(error, "cache-read", "[NavigationPPR] getShell");
    return runMatch({ outcome: "BYPASS", reason: "read-error" });
  }

  let bypassReason: PprReplayBypassReason | undefined;
  let snapshot: ShellSnapshotRecord[] | undefined;
  let snapshotStoreKey: string | undefined;
  let freshness: "fresh" | "stale" = "fresh";
  if (cached) {
    const decision = replayableShellSnapshot(cached.entry, ctx.version);
    if ("snapshot" in decision) {
      snapshot = decision.snapshot;
      snapshotStoreKey = key;
      freshness = cached.shouldRevalidate ? "stale" : "fresh";
    } else {
      bypassReason = decision.reason;
    }
  }

  if (!snapshot) {
    let navigationCached: Awaited<ReturnType<typeof store.getShell>> = null;
    try {
      navigationCached = await store.getShell(navigationKey, {
        claimRevalidation: false,
      });
    } catch (error) {
      reportCacheError(error, "cache-read", "[NavigationPPR] getShell");
      return runMatch({ outcome: "BYPASS", reason: "read-error" });
    }
    if (navigationCached) {
      const decision = replayableShellSnapshot(
        navigationCached.entry,
        ctx.version,
      );
      if ("snapshot" in decision) {
        snapshot = decision.snapshot;
        snapshotStoreKey = navigationKey;
        freshness = navigationCached.shouldRevalidate ? "stale" : "fresh";
      } else {
        bypassReason = decision.reason;
      }
    }
  }

  if (!snapshot) {
    // Report-only marker for routes with an ENABLED route-derived scope: the
    // lookup's own outcome must stay reportable even without a replayable
    // snapshot. An always-false condition() route never produces a doc
    // record (the consumer's write refusal is absolute — see
    // recordShellCaptureDocRecord), so without this its lookup-time refusal
    // would be misreported as the eligibility reason and heal captures would
    // be scheduled for snapshots that can never become consumable. The
    // marker carries NO store: the seeded fallback in withCacheLookup
    // requires one, so nothing can be served through it — it only reports.
    // Bare routes never see it (an installed marker would otherwise mint an
    // implicit scope over the REAL doc: partition in
    // resolveShellImplicitCacheScope).
    if (routeCacheScope?.enabled) {
      const explicit = observeExplicitScope();
      const previousImplicitCache = reqCtx._shellImplicitCache;
      reqCtx._shellImplicitCache = {
        onExplicitHit: explicit.onExplicitHit,
        onExplicitBypass: explicit.onExplicitBypass,
      };
      try {
        const result = await matchPartialForReplay();
        const status = finalizeReplayStatus(
          explicit.status({
            outcome: "BYPASS",
            reason: bypassReason ?? "no-entry",
          }),
        );
        return {
          result,
          status,
          // A lookup-time opt-out makes every heal snapshot unusable
          // (recordShellCaptureDocRecord refuses under the same predicate),
          // and a prerender-served or intercept match never consults a heal
          // snapshot at all. Otherwise heal the shouldHealReplayMiss set PLUS
          // `no-segment-snapshot`: an entry captured while condition() was
          // false legitimately lacks a snapshot, and a later request whose
          // lookup did NOT refuse (condition true now) can heal it — the
          // capture derives from THIS request's context, so its doc record
          // records. Excluding it left replay dead until the document
          // recaptured. The always-false route stays protected: its every
          // lookup refuses, so its bypass suppresses the heal.
          healKey:
            !explicit.bypassed() &&
            reqCtx._pprReplayPostMatchReason === undefined &&
            (shouldHealReplayMiss(bypassReason) ||
              bypassReason === "no-segment-snapshot")
              ? navigationKey
              : undefined,
        };
      } finally {
        reqCtx._shellImplicitCache = previousImplicitCache;
      }
    }
    const match = await runMatch({
      outcome: "BYPASS",
      reason: bypassReason ?? "no-entry",
    });
    return {
      ...match,
      healKey:
        reqCtx._pprReplayPostMatchReason === undefined &&
        shouldHealReplayMiss(bypassReason)
          ? navigationKey
          : undefined,
    };
  }

  const previousImplicitCache = reqCtx._shellImplicitCache;
  const previousLoaderSeed = reqCtx._shellLoaderSeed;
  let loaderSeed: ReturnType<typeof buildShellLoaderSeed> | undefined;
  let segmentReplayHit = false;
  let segmentReplayCorrupt = false;
  const explicit = observeExplicitScope();
  reqCtx._shellImplicitCache = {
    ttl: pprConfig.ttl,
    swr: pprConfig.swr,
    store: new SeededShellStore(store, snapshot),
    keyPrefix: "doc",
    // Arms the bake-lane loader pins a document HIT serves (loader-cache.ts
    // resolveLoaderData), decoded only now: the lookup awaits this before
    // the route's loaders resolve, and an explicit-tier hit or a miss runs
    // the loaders fresh and never reads a pin.
    onHit: async () => {
      segmentReplayHit = true;
      // Never rejects: the lookup awaits this inside its own try, and an
      // unreadable seed leaves those loaders to run fresh.
      const seed = await (loaderSeed ??= buildShellLoaderSeed(snapshot).catch(
        () => undefined,
      ));
      if (seed) reqCtx._shellLoaderSeed = seed;
    },
    onCorrupt: () => {
      segmentReplayCorrupt = true;
    },
    // Arms the explicit-scope composition in withCacheLookup: a route-derived
    // cache() scope stays authoritative, the seeded doc record supplies the
    // match only on its miss. An explicit-tier hit must NOT report a replay
    // HIT — it served under the consumer's own semantics. A lookup-time
    // condition() refusal (or a scope with no store) reports cache-disabled:
    // the gate deliberately does not pre-decide predicates.
    onExplicitHit: explicit.onExplicitHit,
    onExplicitBypass: explicit.onExplicitBypass,
  };

  try {
    const result = await matchPartialForReplay();
    const provisionalStatus: PprReplayStatus = segmentReplayHit
      ? { outcome: "HIT", freshness }
      : explicit.status({ outcome: "BYPASS", reason: "snapshot-miss" });
    // A prerender serve or intercept resolution leaves the seeded record
    // unconsulted (prerender short-circuits before the scope; intercepts
    // keep snapshot.cacheScope) — the "snapshot-miss" guess would blame the
    // capture for a lane that was never in play.
    const status = finalizeReplayStatus(provisionalStatus);
    return {
      result,
      status,
      // A corrupt document snapshot must be overwritten at the document key;
      // writing only the secondary navigation key would leave the preferred
      // document entry shadowing the repair forever. The capture remains marked
      // navigationOnly, so a document request ignores it and recaptures a
      // document-safe shell under the same key.
      healKey:
        segmentReplayCorrupt && reqCtx._pprReplayPostMatchReason === undefined
          ? snapshotStoreKey
          : undefined,
    };
  } finally {
    reqCtx._shellImplicitCache = previousImplicitCache;
    reqCtx._shellLoaderSeed = previousLoaderSeed;
  }
}

/**
 * The full route snapshot for the classified route, or null when
 * classification is unavailable (the gates then fall open to the ordinary
 * replay decision). Persists the enriched snapshot back onto
 * `_classifiedRoute` so the manifest-chain walk runs once per request:
 * matchPartial's createMatchContextForPartial re-reads `_classifiedRoute` and
 * calls ensureFullRouteSnapshot again, and the write-back lets that call hit
 * the entries-already-built fast path and reuse this same scope chain instead
 * of rebuilding it.
 */
function classifiedRouteSnapshot(
  reqCtx: RequestContext<any>,
): RouteSnapshot<any> | null {
  const classified = reqCtx._classifiedRoute;
  if (!classified?.manifestEntry) return null;
  const full = ensureFullRouteSnapshot({
    ...classified,
    entries: classified.entries ?? [],
  });
  reqCtx._classifiedRoute = full;
  return full;
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
 * Buffer a finished tail timing for the next request's Server-Timing, and
 * under debugPerformance print it for this request (whose own Server-Timing
 * was sent at the commit, before the tail ran).
 */
function publishTailTiming(
  tailTiming: ShellTailTiming | null,
  metricsStore: MetricsStore | undefined,
  request: Request,
  url: URL,
): void {
  if (!tailTiming) return;
  publishShellTailTiming(tailTiming);
  if (metricsStore) {
    console.log(
      `[RSC Perf] ${request.method} ${url.pathname} shell tail: ${describeShellTailTiming(tailTiming)}`,
    );
  }
}

const PENDING = Symbol("pending");

/**
 * Whether `value` is not a promise, or a promise that has already settled:
 * racing it against an already-resolved promise, a settled one's reaction is
 * queued first and wins.
 */
async function isSettled(value: unknown): Promise<boolean> {
  if (!(value instanceof Promise)) return true;
  return Promise.race([value, PENDING]).then(
    (first) => first !== PENDING,
    () => true,
  );
}

/**
 * Evict a shell whose doc record cannot be replayed. The store has no shell
 * delete, so the entry is overwritten with a tombstone: a navigationOnly
 * entry with no document half and no snapshot, which document serving
 * treats as a MISS (shellServePlan, the build shell included) and partial
 * replay as `no-segment-snapshot`. The recapture overwrites it with a sound
 * entry. Only for a broken entry: a snapshot read that was merely slow
 * (`snapshotFailure: "unavailable"`) leaves the entry alone.
 */
async function degradeUnreplayableShell(
  descriptor: ShellCaptureDescriptor,
  entry: ShellEntryHead,
  scheduleRecapture: () => void,
): Promise<void> {
  const store = descriptor.store;
  try {
    await store?.putShell?.(
      descriptor.key,
      {
        reactVersion: entry.reactVersion,
        buildVersion: entry.buildVersion,
        snapshot: [],
        navigationOnly: true,
        createdAt: Date.now(),
      },
      descriptor.ttl,
      0,
    );
  } catch (error) {
    reportCacheError(error, "cache-write", "[ShellServe] tombstone");
  }
  store?.dropShellMemo?.(descriptor.key);
  scheduleRecapture();
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
  document: ShellDocument,
  descriptor: ShellCaptureDescriptor,
): Response {
  const { entry, prelude: preludeBytes } = document;
  const metricsStore = reqCtx._metricsStore;
  // Per-stage tail timing for the `ppr:tail` Server-Timing mirror and the
  // perf console line: always in dev, in production only when this request
  // collects debugPerformance metrics. Offsets are relative to this commit
  // point.
  const tailTiming: ShellTailTiming | null =
    process.env.NODE_ENV !== "production" || metricsStore
      ? {
          key: descriptor.key,
          outcome: "complete",
          preludeBytes: preludeBytes.length,
        }
      : null;
  const tailT0 = tailTiming ? performance.now() : 0;
  const scheduleRecapture = (): void =>
    scheduleShellCapture(ctx, request, env, url, reqCtx, ssrModule, descriptor);

  const createTailContext = (): RequestContext<any> => {
    const tailCtx: RequestContext<any> = Object.create(reqCtx);
    // Matching writes render state onto the derived context. Its barrier must
    // close over that same context or a streaming tail inherits the base
    // context's premature non-streaming handle snapshot.
    wireRenderBarrier(tailCtx, handleStore);
    // The tail's render barrier resolves once its record is replayed and
    // before a loader runs (cache-lookup.ts withCacheLookup, yieldFromStore).
    // The store then holds what the prelude was rendered from, so that is
    // the snapshot the document hydrates with; what this request's loaders
    // do to it afterwards reaches the client after hydration
    // (HandleStore.freezeDocumentSnapshot, issue #1035).
    const resolveRenderBarrier = tailCtx._resolveRenderBarrier;
    tailCtx._resolveRenderBarrier = (segments) => {
      handleStore.freezeDocumentSnapshot();
      resolveRenderBarrier(segments);
    };
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
        postponed: document.postponed,
        nonce: undefined,
        // The shell key's own search — identical to the capture seed for
        // this key, so the resume tree matches the captured tree.
        search: shellSearchSeed(url, reqCtx._searchParamsFilter),
        // The HIT request's origin — same host as the capture's (key-scoped).
        origin: url.origin,
        // The document cache reads the list before storing this composite.
        onError: (error) => {
          reqCtx._renderErrors?.push(error);
        },
      }),
    );
  };

  const tailPromise: Promise<
    ReadableStream<Uint8Array> | { redirect: string }
  > = (async () => {
    // Snapshot seeding (docs/design/ppr-shell-resume.md): the tail render must
    // match the frozen prelude, so it replays the doc record and serves the
    // bake-lane loader pins, on a DERIVED context so the shared reqCtx is
    // untouched. Every cache read the tail makes, a hole's included, goes to
    // the request's own store.
    // A prelude-first read delivers the snapshot on its own promise: the
    // prelude is already committed, so only the tail waits for it.
    const inMemory = await isSettled(document.snapshot);
    const snapshot = await document.snapshot;
    // A snapshot already in memory (shell memo, memory store, build shells)
    // resolves at once, and the tail's seeding and match would run ahead of
    // the runtime writing the prelude: one macrotask first. A snapshot still
    // arriving on I/O has yielded by the time it resolves.
    if (inMemory) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (tailTiming) {
      tailTiming.snapshotMs = Math.round(performance.now() - tailT0);
      if (snapshot)
        tailTiming.snapshotRecords = countSnapshotFamilies(snapshot);
      tailTiming.snapshotPruned = entry.prunedRecords;
      const snapshotStats = document.stats?.snapshot;
      if (snapshotStats) {
        tailTiming.snapshotReadMs = Math.round(snapshotStats.readMs);
        tailTiming.snapshotBytes = snapshotStats.bytes;
        tailTiming.snapshotParseMs = Math.round(snapshotStats.parseMs);
      }
    }
    const seededCtx = createTailContext();
    const records = snapshot ?? [];
    // Loader-family records (bake-lane containers, loader-container-bake):
    // decode into a seed Map for the resolveLoaderData overlay, so the
    // payload's baked container bytes match the frozen prelude while the
    // hole-marker paths keep the fresh run's live nested promises.
    const seedStart =
      INTERNAL_RANGO_DEBUG || tailTiming ? performance.now() : 0;
    const loaderSeed =
      records.length > 0 ? await buildShellLoaderSeed(records) : undefined;
    if (tailTiming) {
      const seededAt = performance.now();
      tailTiming.seedMs = Math.round(seededAt - tailT0);
      tailTiming.seedCpuMs = Math.round(seededAt - seedStart);
    }
    if (INTERNAL_RANGO_DEBUG) {
      console.log(
        `[Server][ppr] shell HIT: loader seed built +${Math.round(performance.now() - seedStart)}ms (abs ${Math.round(performance.now())})`,
      );
    }
    if (loaderSeed) seededCtx._shellLoaderSeed = loaderSeed;
    // The handler layer is REPLAYED from the entry's own doc record, never
    // executed: the implicit doc scope replaces any route-derived scope
    // (docTail), looks the record up by the key the capture wrote
    // (fixedDocKey), and reads it from a segment-only overlay of the snapshot
    // (the real store never holds a doc: record). A lookup that does not hit
    // throws ShellRecordUnavailableError (withCacheLookup), handled by the
    // degrade below. Live and promise-carrying bake-lane loaders still run
    // fresh; a promise-free bake-lane loader is served from its pin
    // (_shellLoaderSeed, loader-cache.ts). A Prerender route's tail takes
    // the handler layer from the prerender store before this scope is
    // consulted, and the loader pushes from `prerenderHandles`.
    seededCtx._shellImplicitCache = {
      ttl: descriptor.ttl,
      swr: descriptor.swr,
      store: new SeededShellStore(reqCtx._cacheStore!, records),
      keyPrefix: "doc",
      docTail: true,
      fixedDocKey: entry.docKey,
      prerenderHandles: shellPrerenderHandles(records),
    };
    // Fragment splice (issue #700): store hits in THIS tail emit their stored
    // segment fragments verbatim (expanded by segment-fragments.ts). The flag
    // lives on the derived context so it can never leak into a capture render,
    // which serializes segments and must see real elements.
    seededCtx._shellFragmentPayload = true;
    return runWithRequestContext(seededCtx, () => renderTail(seededCtx));
  })();
  // The stream below is the only consumer; pre-attach a no-op catch so a tail
  // failure before the stream is pulled never surfaces as an unhandled rejection.
  tailPromise.catch(() => {});

  const serveStart = INTERNAL_RANGO_DEBUG ? performance.now() : 0;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Fixed-size chunks (SHELL_PRELUDE_CHUNK_BYTES): a compressor in front
      // of the worker emits after each chunk instead of after the whole
      // prelude. slice() gives every chunk its own buffer.
      const commitStart = metricsStore ? performance.now() : 0;
      let chunks = 0;
      for (
        let offset = 0;
        offset < preludeBytes.length;
        offset += SHELL_PRELUDE_CHUNK_BYTES
      ) {
        controller.enqueue(
          preludeBytes.slice(offset, offset + SHELL_PRELUDE_CHUNK_BYTES),
        );
        chunks++;
      }
      if (metricsStore) {
        appendMetric(
          metricsStore,
          "ppr:shell-commit",
          commitStart,
          performance.now() - commitStart,
          undefined,
          `cpu chunks=${chunks} prelude=${preludeBytes.length}b`,
        );
      }
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
              inlineShellScript(
                `location.replace(${escapeJsonForScript(JSON.stringify(safeTarget))})`,
              ),
            ),
          );
          if (tailTiming) {
            tailTiming.outcome = "redirect";
            tailTiming.completeMs = Math.round(performance.now() - tailT0);
          }
        }
        publishTailTiming(tailTiming, metricsStore, request, url);
        controller.close();
      } catch (error) {
        if (error instanceof ShellRecordUnavailableError) {
          // The doc record could not supply the handler layer, and running
          // handlers behind a committed prelude is exactly what a HIT must
          // never do: reload the page into a forced MISS. A broken entry is
          // also replaced (tombstone, memo dropped, recapture); one whose
          // snapshot read was only slow stays, and the next request reads it
          // again.
          if ((await document.snapshotFailure) !== "unavailable") {
            await degradeUnreplayableShell(
              descriptor,
              entry,
              scheduleRecapture,
            );
          }
          controller.enqueue(new TextEncoder().encode(shellReloadScript()));
          if (tailTiming) {
            tailTiming.outcome = "error";
            tailTiming.completeMs = Math.round(performance.now() - tailT0);
          }
          publishTailTiming(tailTiming, metricsStore, request, url);
          controller.close();
          return;
        }
        // Self-heal on a failed tail: errors the pre-commit gates cannot catch
        // (mismatched postponed blob, hard render error above the holes) throw
        // here AFTER the 200 + prelude flushed and would re-fail on every
        // request until the entry ages out — recapture overwrites the entry.
        // Client disconnects land here too; the recapture is idempotent and
        // bounded by scheduleShellCapture's stampede guard + backoff.
        scheduleRecapture();
        if (tailTiming) {
          tailTiming.outcome = "error";
          tailTiming.completeMs = Math.round(performance.now() - tailT0);
        }
        publishTailTiming(tailTiming, metricsStore, request, url);
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
