/**
 * Producer B: build-time PPR shell capture for Prerender+ppr routes (#699).
 *
 * Runs in the RSC realm of the build's temp server, AFTER all bundles are
 * written (the prelude embeds built client asset URLs — bootstrap module,
 * chunk preloads — that only exist post-client-build). The capture core is
 * producer A's, verbatim: deriveShellCaptureContext (mask funnel, liveness,
 * snapshot recording, implicit doc-cache scope) + captureAndStoreShell (gates,
 * quiesce, tags union, putShell barrier). The differences are only the base
 * context (a synthetic build request created via createRequestContext over the
 * build env — no ambient identity, so the identity guard is trivially
 * satisfied) and the sink (an entry collector instead of a runtime store).
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
} from "../server/request-context.js";
import {
  deriveShellCaptureContext,
  captureAndStoreShell,
  type ShellCaptureDescriptor,
} from "../rsc/shell-capture.js";
import { buildFullPayload } from "../rsc/full-payload.js";
import type { RscPayload, SSRModule } from "../rsc/types.js";
import type { HandlerContext } from "../rsc/handler-context.js";
import { renderToReadableStream } from "../deps/rsc.js";
import {
  resolvePprConfig,
  type ResolvedPprConfig,
} from "../rsc/shell-serve.js";

/** Delay before the single in-place retry of a cold-graph build capture. */
const BUILD_CAPTURE_RETRY_DELAY_MS = 400;

/**
 * Normalize a collected truthy `ppr` path option into the SAME concrete
 * policy the runtime serve path derives — through resolvePprConfig itself,
 * over a synthetic route entry — so the build-stamped ttl default can never
 * drift from the serve-side one.
 */
export function resolveBuildPprConfig(
  ppr: true | { ttl?: number; swr?: number; tags?: string[] },
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
    /** The router swept does not own this URL — try the next one. */
    | "route-mismatch";
  /** Present iff outcome === "stored". */
  entry?: ShellCacheEntry;
  /** The putShell-barrier tag union (static ppr.tags + render-recorded). */
  tags?: string[];
  /** On route-mismatch: what this router's match actually landed on. */
  matchedRouteName?: string;
}

/** Sleep `ms`, unref'd so the build process is never kept alive by the timer. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });
}

/**
 * Capture the PPR shell for one prerendered URL at build time. Retries once
 * in place on `no-shell` (the first attempt warms the temp server's SSR/Flight
 * transform graph, mirroring producer A's cold-start retry).
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
  await delay(BUILD_CAPTURE_RETRY_DELAY_MS);
  return attemptBuildCapture(opts);
}

/** One attempt: fresh base context, fresh derivation, fresh render. */
async function attemptBuildCapture(
  opts: BuildShellCaptureOptions,
): Promise<BuildShellCaptureResult> {
  const router = opts.router;
  const url = new URL(opts.urlPath, "http://build.invalid");
  const request = new Request(url, { method: "GET" });

  // Synthetic build request context: same factory the runtime handler uses,
  // so the capture's ALS surface (cookie machinery, variables, waitUntil,
  // theme resolution) is production-shaped. No cookie header → theme resolves
  // to the app default, exactly like a first anonymous visitor's capture.
  const baseCtx = createRequestContext({
    env: (opts.buildEnv ?? {}) as any,
    request,
    url,
    variables: {},
    // Fresh empty store per attempt: cache()/"use cache" reads MISS, execute,
    // and are recorded into the snapshot by the derivation's RecordingShell
    // wrapper — the entry pins its own generation, nothing preexisting leaks.
    cacheStore: new MemorySegmentCacheStore(),
    themeConfig: router.themeConfig ?? null,
    stateCookieName: router.resolvedStateCookieName,
    version: opts.buildVersion,
  });

  const { derivedCtx, freshHandleStore } = deriveShellCaptureContext(baseCtx, {
    ttl: opts.ttl,
    swr: opts.swr,
  });

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
    buildVersion: opts.buildVersion,
    ttl: opts.ttl,
    swr: opts.swr,
    tags: opts.tags,
    store: collector as any,
    debug: opts.debug,
  };

  let mismatchedRouteName: string | undefined;
  const outcome = await runWithRequestContext(derivedCtx, async () => {
    const match = await router.match(request, { env: opts.buildEnv ?? {} });
    if (match.routeName !== opts.routeName) {
      mismatchedRouteName = match.routeName;
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

    return captureAndStoreShell(
      { captureShellHTML: opts.captureShellHTML } as SSRModule,
      rscStream,
      freshHandleStore,
      derivedCtx,
      descriptor,
    );
  });

  if (outcome === "stored" && collected !== null) {
    const hit: { entry: ShellCacheEntry; tags?: string[] } = collected;
    return { outcome, entry: hit.entry, tags: hit.tags };
  }
  if (outcome === "route-mismatch") {
    return { outcome, matchedRouteName: mismatchedRouteName };
  }
  return { outcome };
}
