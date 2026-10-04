/**
 * Producer B: build-time PPR shell capture for Prerender+ppr routes (#699).
 *
 * Runs in the RSC realm of the build's temp server, AFTER all bundles are
 * written (the prelude embeds built client asset URLs — bootstrap module,
 * chunk preloads — that only exist post-client-build). The capture core is
 * producer A's, verbatim: deriveShellCaptureContext (push funnel, snapshot
 * recording, implicit doc-cache scope) + settleCaptureRecord (the record-first
 * step) + captureAndStoreShell (gates, quiesce, tags union, putShell barrier). Build capture first replays global
 * and route middleware with a synthetic build request context
 * (`ctx.build === true`, inert `ctx.waitUntil()`); middleware can seed vars or
 * call `ctx.dynamic()` to skip this URL. The sink is an entry collector instead
 * of a runtime store.
 *
 * The capture's match() re-enters withCacheLookup, HITs the in-realm prerender
 * store seeded from the just-collected Flight payloads, and REPLAYS the
 * build-time segments — no handler execution, exactly the runtime composition
 * path (#697). Live-lane loaders mask into holes; bake-lane loaders execute
 * under the build context and refuse the capture if they reject or read
 * identity, the same eligibility rules as at runtime.
 */

import type { ShellCacheEntry } from "../cache/types.js";
import type { RouterVersions } from "../router-versions.js";
import type { MatchResult } from "../types.js";
import { MemorySegmentCacheStore } from "../cache/memory-segment-store.js";
import {
  createRequestContext,
  runWithRequestContext,
  setRequestContextParams,
  type RequestContext,
} from "../server/request-context.js";
import {
  deriveShellCaptureContext,
  captureAndStoreShell,
  settleCaptureRecord,
  delay,
  SHELL_CAPTURE_RETRY_DELAY_MS,
  type ShellCaptureDescriptor,
} from "../rsc/shell-capture.js";
import { SHELL_CAPTURE_MAX_WAIT_MS } from "../rsc/shell-capture-constants.js";
import { raceDeadline } from "../cache/background-task.js";
import { buildFullPayload } from "../rsc/full-payload.js";
import { buildRouteMiddlewareEntries } from "../rsc/helpers.js";
import type { RscPayload, SSRModule } from "../rsc/types.js";
import type { HandlerContext } from "../rsc/handler-context.js";
import { renderToReadableStream } from "../deps/rsc.js";
import { isRouteNotFoundError } from "../errors.js";
import { createReverseFunction } from "../router/handler-context.js";
import { executeMiddleware, matchMiddleware } from "../router/middleware.js";
import type { MiddlewareEntry } from "../router/middleware.js";
import { getGlobalRouteMap } from "../route-map-builder.js";
import {
  resolvePprConfig,
  type ResolvedPprConfig,
} from "../rsc/shell-serve.js";

/**
 * Normalize a collected truthy `ppr` path option into the SAME concrete
 * policy the runtime serve path derives — through resolvePprConfig itself,
 * over a synthetic route entry — so the build-stamped ttl default can never
 * drift from the serve-side one.
 */
export function resolveBuildPprConfig(
  ppr:
    | true
    | { ttl?: number; swr?: number; tags?: string[]; captureTimeout?: number },
): ResolvedPprConfig {
  const resolved = resolvePprConfig({ type: "route", ppr } as any);
  // resolvePprConfig returns null only for undefined/false ppr; the collector
  // filtered those out. Guard for the type only.
  if (!resolved) throw new Error("[rango] unreachable: ppr option was falsy");
  return resolved;
}

export interface BuildShellCaptureOptions {
  /** The router instance (from RouterRegistry in the same realm). */
  router: any;
  /** Concrete URL path to capture (e.g. "/pp/alpha"). */
  urlPath: string;
  /**
   * The candidate's trie route key. The capture's match() must land on THIS
   * route: the phase sweeps every registered router, and a router that does
   * not own the URL matches something else (its catch-all, a 404 shape) —
   * that capture must not be baked.
   */
  routeName: string;
  /** Shell store key to stamp into the descriptor (host-free at build). */
  key: string;
  ttl?: number;
  swr?: number;
  /** The route's static ppr.tags (the capture unions render-recorded tags). */
  tags?: string[];
  /**
   * The route's resolved snapshot size cap (ResolvedPprConfig.maxSnapshotBytes)
   * — build captures apply the same over-cap skip as runtime captures, so a
   * raised per-route cap behaves identically across both producers.
   */
  maxSnapshotBytes?: number;
  /**
   * The route's `ppr.captureTimeout` (ms) — producer B honors the same settle
   * budget as the runtime capture. Build has no waitUntil lifetime bound, so
   * the option is the only ceiling here.
   */
  captureTimeout?: number;
  /** Build-time env bindings (rango plugin buildEnv), if configured. */
  buildEnv?: unknown;
  /**
   * The versions the SHIPPED build serves this router with (the build table,
   * or the router's consumer-set version) — NOT the temp server's own
   * version-plugin stamp. The serve-side isValidShellHit gate compares
   * entry.buildVersion against the running worker's ctx.version, which is the
   * document version; stamping the temp server's would make every build entry
   * an eternal MISS.
   */
  versions: RouterVersions;
  /**
   * The SSR half, composed by the plugin from the temp server's SSR
   * environment runner (react-dom/static prerender + Flight client), with the
   * bootstrap script content overridden to the BUILT client entry URL.
   */
  captureShellHTML: NonNullable<SSRModule["captureShellHTML"]>;
  /** Verbose per-attempt breadcrumbs (build log). */
  debug?: boolean;
}

export interface BuildShellCaptureResult {
  outcome:
    | "stored"
    | "no-shell"
    | "redirect"
    | "refused"
    /** Middleware/handler opted this URL out of PPR shell capture. */
    | "dynamic"
    /** The router swept does not own this URL — try the next one. */
    | "route-mismatch";
  /** Present iff outcome === "stored". */
  entry?: ShellCacheEntry;
  /** The putShell-barrier tag union (static ppr.tags + render-recorded). */
  tags?: string[];
  /** On route-mismatch: what this router's match actually landed on. */
  matchedRouteName?: string;
  /**
   * On no-shell: the attempt ran out of ppr.captureTimeout. It is not
   * retried: its match may still be running, and the retry would start the
   * same work beside it (runtime twin: shell-capture.ts runShellCapture).
   */
  timedOut?: true;
}

/**
 * Capture the PPR shell for one prerendered URL at build time. Retries once
 * in place on `no-shell` (the first attempt warms the temp server's SSR/Flight
 * transform graph, mirroring producer A's cold-start retry — same delay),
 * unless the attempt ran out of ppr.captureTimeout (`timedOut`).
 */
export async function captureShellForBuild(
  opts: BuildShellCaptureOptions,
): Promise<BuildShellCaptureResult> {
  const first = await attemptBuildCapture(opts);
  if (first.outcome !== "no-shell" || first.timedOut) return first;
  if (opts.debug) {
    console.log(
      `[rango] shell capture attempt 1/2 for ${opts.urlPath} produced no shell (cold graph?) — retrying`,
    );
  }
  await delay(SHELL_CAPTURE_RETRY_DELAY_MS);
  return attemptBuildCapture(opts);
}

/** One attempt: fresh base context, fresh derivation, fresh render. */
async function attemptBuildCapture(
  opts: BuildShellCaptureOptions,
): Promise<BuildShellCaptureResult> {
  const router = opts.router;
  const url = new URL(opts.urlPath, "http://build.invalid");
  const request = new Request(url, { method: "GET" });
  const env = (opts.buildEnv ?? {}) as any;
  const variables: Record<string, any> = {};

  // Synthetic build request context: same factory the runtime handler uses,
  // so the capture's ALS surface (cookie machinery, variables, waitUntil,
  // theme resolution) is production-shaped. No cookie header → theme resolves
  // to the app default, exactly like a first anonymous visitor's capture.
  const baseCtx = createRequestContext({
    env,
    request,
    url,
    variables,
    build: true,
    // Fresh empty store per attempt: cache()/"use cache" reads MISS, execute,
    // and are recorded into the snapshot by the derivation's RecordingShell
    // wrapper — the entry pins its own generation, nothing preexisting leaks.
    cacheStore: new MemorySegmentCacheStore(),
    themeConfig: router.themeConfig ?? null,
    stateCookieName: router.resolvedStateCookieName,
    versions: opts.versions,
  });
  // Scope registry lookups (root-scope/search-schema) per router during the
  // bake, mirroring rsc/handler.ts on the request path (#762).
  baseCtx._routerId = router.id;

  // Entry collector: captureAndStoreShell's sink. putShell never fails here,
  // so a "stored" outcome always carries the entry.
  let collected: { entry: ShellCacheEntry; tags?: string[] } | null = null;
  const collector = {
    putShell: async (
      _key: string,
      entry: ShellCacheEntry,
      _ttl?: number,
      _swr?: number,
      tags?: string[],
    ): Promise<void> => {
      collected = { entry, tags };
    },
  };

  const descriptor: ShellCaptureDescriptor = {
    key: opts.key,
    buildVersion: opts.versions.document,
    ttl: opts.ttl,
    swr: opts.swr,
    tags: opts.tags,
    captureTimeout: opts.captureTimeout,
    store: collector as any,
    maxSnapshotBytes: opts.maxSnapshotBytes,
  };

  const result = await runWithRequestContext(
    baseCtx,
    async (): Promise<
      | BuildCaptureRunResult
      | { outcome: "route-mismatch"; matchedRouteName?: string }
    > => {
      const preview =
        typeof router.previewMatch === "function"
          ? await router.previewMatch(request, { env })
          : undefined;
      // These preview-based mismatches exit before any middleware/envelope runs,
      // so nothing consumes a response.
      if (preview === null) {
        return { outcome: "route-mismatch" };
      }
      if (preview?.routeKey && preview.routeKey !== opts.routeName) {
        return {
          outcome: "route-mismatch",
          matchedRouteName: preview.routeKey,
        };
      }

      if (preview?.routeKey) {
        setRequestContextParams(preview.params ?? {}, preview.routeKey);
      }

      // Global-only, like the live request's middleware reverse
      // (rsc/handler.ts: createReverseFunction(getRequiredRouteMap())): no
      // include() scope, no param auto-fill. A scoped reverse here resolved
      // `.name` at build while the live request threw `Unknown route`.
      const middlewareReverse = createReverseFunction(getGlobalRouteMap());

      const runCapture = () =>
        runBuildCaptureFinal({
          baseCtx,
          descriptor,
          env,
          opts,
          request,
          router,
          url,
        });

      const routeMiddleware =
        preview?.routeMiddleware && preview.routeMiddleware.length > 0
          ? buildRouteMiddlewareEntries(preview.routeMiddleware)
          : [];
      const runRouteMiddleware = () =>
        runBuildMiddlewareEnvelope(
          routeMiddleware,
          request,
          env,
          variables,
          runCapture,
          middlewareReverse,
          baseCtx,
        );

      const globalMiddleware = Array.isArray(router.middleware)
        ? matchMiddleware(url.pathname, router.middleware)
        : [];
      return runBuildMiddlewareEnvelope(
        globalMiddleware,
        request,
        env,
        variables,
        runRouteMiddleware,
        middlewareReverse,
        baseCtx,
      );
    },
  );

  const outcome = result.outcome;
  if (outcome === "stored" && collected !== null) {
    const hit: { entry: ShellCacheEntry; tags?: string[] } = collected;
    return { outcome, entry: hit.entry, tags: hit.tags };
  }
  if (outcome === "route-mismatch") {
    return { outcome, matchedRouteName: result.matchedRouteName };
  }
  if (outcome === "no-shell" && "timedOut" in result && result.timedOut) {
    return { outcome, timedOut: true };
  }
  return { outcome };
}

type BuildShellCaptureOutcome = BuildShellCaptureResult["outcome"];

interface BuildCaptureRunResult {
  outcome: BuildShellCaptureOutcome;
  response: Response;
  /** On route-mismatch: what this router's match landed on. */
  matchedRouteName?: string;
  /** On no-shell: the attempt ran out of ppr.captureTimeout. */
  timedOut?: true;
}

interface BuildCaptureFinalOptions {
  baseCtx: RequestContext<any>;
  descriptor: ShellCaptureDescriptor;
  env: any;
  opts: BuildShellCaptureOptions;
  request: Request;
  router: any;
  url: URL;
}

async function runBuildMiddlewareEnvelope<TEnv>(
  middlewares: Array<{
    entry: MiddlewareEntry<TEnv>;
    params: Record<string, string>;
  }>,
  request: Request,
  env: TEnv,
  variables: Record<string, any>,
  finalHandler: () => Promise<BuildCaptureRunResult>,
  reverse: (
    name: string,
    params?: Record<string, string>,
    search?: Record<string, unknown>,
  ) => string,
  baseCtx: RequestContext<any>,
): Promise<BuildCaptureRunResult> {
  let downstream: BuildCaptureRunResult | undefined;
  const response = await executeMiddleware(
    middlewares,
    request,
    env,
    variables,
    async () => {
      downstream = baseCtx._dynamic
        ? {
            outcome: "dynamic",
            response: responseForBuildCaptureOutcome("dynamic"),
          }
        : await finalHandler();
      return downstream.response;
    },
    reverse,
  );

  if (baseCtx._dynamic) {
    return { outcome: "dynamic", response };
  }
  if (response.status >= 300 && response.status < 400) {
    return { outcome: "redirect", response };
  }
  return (
    downstream ?? {
      outcome: "no-shell",
      response,
    }
  );
}

async function runBuildCaptureFinal(
  options: BuildCaptureFinalOptions,
): Promise<BuildCaptureRunResult> {
  const { baseCtx, descriptor, env, opts, request, router, url } = options;
  // No baseCtx._dynamic recheck here: the only caller is the route envelope's
  // finalHandler wrapper, which already short-circuits to "dynamic" without
  // invoking this when baseCtx._dynamic is set. A loader/handler opting out
  // DURING the capture render is caught by the derivedCtx._dynamic check below.

  const derivation = deriveShellCaptureContext(baseCtx, {
    ttl: opts.ttl,
    swr: opts.swr,
  });
  const { derivedCtx, freshHandleStore } = derivation;
  // The capture generation starts before the match, as at runtime
  // (ShellCacheEntry.createdAt; the build-shell read-through compares tag
  // invalidations against it).
  const captureStartedAt = Date.now();

  const result = await runWithRequestContext(
    derivedCtx,
    async (): Promise<Omit<BuildCaptureRunResult, "response">> => {
      // Same one deadline as the runtime capture: the match, the record-first
      // step, then the prerender with what is left.
      const deadline =
        Date.now() + (opts.captureTimeout ?? SHELL_CAPTURE_MAX_WAIT_MS);
      let match: MatchResult;
      try {
        const matched = await raceDeadline<MatchResult>(
          router.match(request, { env }),
          deadline,
        );
        if (!matched.done) return { outcome: "no-shell", timedOut: true };
        match = matched.value;
      } catch (error) {
        if (isPlainPathMiss(error, opts.urlPath)) {
          return { outcome: "route-mismatch" };
        }
        throw error;
      }
      if (match.routeName !== opts.routeName) {
        return { outcome: "route-mismatch", matchedRouteName: match.routeName };
      }
      if (match.redirect) return { outcome: "redirect" };

      setRequestContextParams(match.params, match.routeName);

      // Same record-first step as the runtime capture. A prerendered URL's
      // match comes from the prerender store (no handler runs, no doc record),
      // which settleCaptureRecord reports as `prerender`.
      const settled = await settleCaptureRecord(
        match,
        derivation,
        descriptor,
        deadline,
      );
      if (settled.kind === "refused") {
        return { outcome: derivedCtx._dynamic ? "dynamic" : "refused" };
      }
      if (settled.kind === "timeout") {
        return { outcome: "no-shell", timedOut: true };
      }

      const payload = buildFullPayload(
        settled.match,
        // buildFullPayload reads only ctx.router.* and ctx.version.
        {
          router,
          version: opts.versions.document,
        } as unknown as HandlerContext<any>,
        url,
        derivedCtx,
        freshHandleStore,
      );
      const rscStream = renderToReadableStream<RscPayload>(payload, {
        onError: (error: unknown) => {
          if (opts.debug) {
            console.warn(
              `[rango] shell capture render error for ${opts.urlPath}:`,
              error,
            );
          }
        },
      });

      const captureOutcome = await captureAndStoreShell(
        { captureShellHTML: opts.captureShellHTML } as SSRModule,
        rscStream,
        derivedCtx,
        { ...descriptor, captureTimeout: Math.max(1, deadline - Date.now()) },
        captureStartedAt,
      );
      if (derivedCtx._dynamic) return { outcome: "dynamic" };
      if (captureOutcome === "no-shell" && Date.now() >= deadline) {
        return { outcome: "no-shell", timedOut: true };
      }
      // A route cache() record that ran out mid-capture: the in-place retry
      // (captureShellForBuild) reads or renders a newer one.
      return {
        outcome: captureOutcome === "expired" ? "no-shell" : captureOutcome,
      };
    },
  );

  return {
    ...result,
    response: responseForBuildCaptureOutcome(result.outcome),
  };
}

function responseForBuildCaptureOutcome(
  outcome: BuildShellCaptureOutcome,
): Response {
  if (outcome === "redirect") {
    return new Response(null, {
      status: 302,
      headers: { location: "http://build.invalid/" },
    });
  }
  return new Response(null, { status: 204 });
}

function isPlainPathMiss(error: unknown, pathname: string): boolean {
  if (!isRouteNotFoundError(error)) return false;
  const cause = (error as { cause?: unknown }).cause;
  return (
    cause !== null &&
    typeof cause === "object" &&
    (cause as { pathname?: unknown }).pathname === pathname
  );
}
