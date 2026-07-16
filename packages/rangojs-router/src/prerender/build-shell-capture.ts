/**
 * Producer B: build-time PPR shell capture for Prerender+ppr routes (#699).
 *
 * Runs in the RSC realm of the build's temp server, AFTER all bundles are
 * written (the prelude embeds built client asset URLs — bootstrap module,
 * chunk preloads — that only exist post-client-build). The capture core is
 * producer A's, verbatim: deriveShellCaptureContext (mask funnel, liveness,
 * snapshot recording, implicit doc-cache scope) + captureAndStoreShell (gates,
 * quiesce, tags union, putShell barrier). Build capture first replays global
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
  delay,
  SHELL_CAPTURE_RETRY_DELAY_MS,
  type ShellCaptureDescriptor,
} from "../rsc/shell-capture.js";
import { buildFullPayload } from "../rsc/full-payload.js";
import { buildRouteMiddlewareEntries } from "../rsc/helpers.js";
import type { RscPayload, SSRModule } from "../rsc/types.js";
import type { HandlerContext } from "../rsc/handler-context.js";
import { renderToReadableStream } from "../deps/rsc.js";
import { isRouteNotFoundError } from "../errors.js";
import { createReverseFunction } from "../router/handler-context.js";
import { executeMiddleware, matchMiddleware } from "../router/middleware.js";
import type { MiddlewareEntry } from "../router/middleware.js";
import { getGlobalRouteMap, isRouteRootScoped } from "../route-map-builder.js";
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
   * The MAIN build's version (the version plugin's value folded into the
   * shipped worker) — NOT the temp server's own version-plugin value. The
   * serve-side isValidShellHit gate compares entry.buildVersion against the
   * running worker's ctx.version; stamping the temp server's would make every
   * build entry an eternal MISS.
   */
  buildVersion: string;
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
    | "write-failed"
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
}

/**
 * Capture the PPR shell for one prerendered URL at build time. Retries once
 * in place on `no-shell` (the first attempt warms the temp server's SSR/Flight
 * transform graph, mirroring producer A's cold-start retry — same delay).
 */
export async function captureShellForBuild(
  opts: BuildShellCaptureOptions,
): Promise<BuildShellCaptureResult> {
  const first = await attemptBuildCapture(opts);
  if (first.outcome !== "no-shell") return first;
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
    version: opts.buildVersion,
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
    ): Promise<{ outcome: "stored" }> => {
      collected = { entry, tags };
      return { outcome: "stored" };
    },
  };

  const descriptor: ShellCaptureDescriptor = {
    key: opts.key,
    buildVersion: opts.buildVersion,
    ttl: opts.ttl,
    swr: opts.swr,
    tags: opts.tags,
    captureTimeout: opts.captureTimeout,
    store: collector as any,
    debug: opts.debug,
    maxSnapshotBytes: opts.maxSnapshotBytes,
  };

  let mismatchedRouteName: string | undefined;
  const result = await runWithRequestContext(baseCtx, async () => {
    const preview =
      typeof router.previewMatch === "function"
        ? await router.previewMatch(request, { env })
        : undefined;
    // These preview-based mismatches exit before any middleware/envelope runs,
    // so nothing consumes a response — only result.outcome is read below.
    if (preview === null) {
      return { outcome: "route-mismatch" } as const;
    }
    if (preview?.routeKey && preview.routeKey !== opts.routeName) {
      mismatchedRouteName = preview.routeKey;
      return { outcome: "route-mismatch" } as const;
    }

    if (preview?.routeKey) {
      setRequestContextParams(preview.params ?? {}, preview.routeKey);
    }

    const routeReverse = createReverseFunction(
      getGlobalRouteMap(),
      preview?.routeKey,
      preview?.params ?? {},
      preview?.routeKey
        ? isRouteRootScoped(preview.routeKey, router.id)
        : undefined,
    );

    const runCapture = () =>
      runBuildCaptureFinal({
        baseCtx,
        descriptor,
        env,
        opts,
        request,
        router,
        url,
        setMismatchedRouteName: (routeName) => {
          mismatchedRouteName = routeName;
        },
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
        routeReverse,
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
      routeReverse,
      baseCtx,
    );
  });

  const outcome = result.outcome;
  if (outcome === "stored" && collected !== null) {
    const hit: { entry: ShellCacheEntry; tags?: string[] } = collected;
    return { outcome, entry: hit.entry, tags: hit.tags };
  }
  if (outcome === "route-mismatch") {
    return { outcome, matchedRouteName: mismatchedRouteName };
  }
  return { outcome };
}

type BuildShellCaptureOutcome = BuildShellCaptureResult["outcome"];

interface BuildCaptureRunResult {
  outcome: BuildShellCaptureOutcome;
  response: Response;
}

interface BuildCaptureFinalOptions {
  baseCtx: RequestContext<any>;
  descriptor: ShellCaptureDescriptor;
  env: any;
  opts: BuildShellCaptureOptions;
  request: Request;
  router: any;
  url: URL;
  setMismatchedRouteName(routeName: string | undefined): void;
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

  const { derivedCtx, freshHandleStore } = deriveShellCaptureContext(baseCtx, {
    ttl: opts.ttl,
    swr: opts.swr,
  });

  const outcome = await runWithRequestContext(derivedCtx, async () => {
    let match;
    try {
      match = await router.match(request, { env });
    } catch (error) {
      if (isPlainPathMiss(error, opts.urlPath)) {
        return "route-mismatch" as const;
      }
      throw error;
    }
    if (match.routeName !== opts.routeName) {
      options.setMismatchedRouteName(match.routeName);
      return "route-mismatch" as const;
    }
    if (match.redirect) return "redirect" as const;

    setRequestContextParams(match.params, match.routeName);

    const payload = buildFullPayload(
      match,
      // buildFullPayload reads only ctx.router.* and ctx.version.
      { router, version: opts.buildVersion } as unknown as HandlerContext<any>,
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
      freshHandleStore,
      derivedCtx,
      descriptor,
    );
    return derivedCtx._dynamic ? "dynamic" : captureOutcome;
  });

  return {
    outcome,
    response: responseForBuildCaptureOutcome(outcome),
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
