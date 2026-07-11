/**
 * Build-time shell entry read-through (producer B, issue #699).
 *
 * The build stages one ShellCacheEntry per Prerender+ppr URL as a lazy
 * manifest module injected into the RSC bundle
 * (`globalThis.__loadShellManifestModule`, mirroring the prerender payload
 * manifest — the worker handles every request; nothing is served from
 * assets). The serve path consults this on a runtime shell-store MISS, so the
 * FIRST request after a deploy is already a shell HIT with zero runtime
 * capture. The worker cannot tell where an entry came from: a build hit is
 * served through the same serveShellHit as a captured one.
 *
 * Lifecycle:
 * - No expiry until the next deploy — the buildVersion gate retires entries
 *   the moment a new build ships (a new manifest replaces them anyway).
 * - `ppr.ttl` drives STALENESS ONLY: past createdAt + ttl the entry still
 *   serves, but a runtime recapture is scheduled — SWR is the UPGRADE path
 *   from build entry to fresher runtime entry, not the bootstrap path. The
 *   runtime store is consulted first, so a captured entry supersedes the
 *   build entry as soon as it lands.
 * - `updateTag()` evicts build entries like runtime ones: the read-through
 *   validates the entry's baked tag union against the store's tag
 *   invalidation markers (isTagsInvalidatedSince) with the entry's createdAt
 *   as the reference instant. No tombstones — the manifest is immutable; the
 *   markers say whether it is still current.
 */

import type { SegmentCacheStore, ShellCacheEntry } from "../cache/types.js";
import { sortedSearchString } from "../cache/cache-key-utils.js";
import {
  DEV_SHELL_PROBE_TIMEOUT_MS,
  hasIntactShellPayload,
  isValidShellHit,
} from "./shell-serve.js";
import { SHELL_CAPTURE_MAX_WAIT_MS } from "./shell-capture.js";
import { buildShellManifestKey } from "../prerender/shell-manifest-key.js";

/** One baked manifest record (the __ps asset module's default export). */
export interface BuildShellEntry {
  entry: ShellCacheEntry;
  /** Resolved ppr ttl (seconds) — drives staleness/recapture, never expiry. */
  ttl: number;
  swr?: number;
  /** The putShell-barrier tag union baked at build (static + recorded). */
  tags?: string[];
  routeName: string;
}

interface ShellManifestModule {
  /** Manifest key (pathname — see shell-manifest-key.ts) -> asset specifier. */
  default: Record<string, string>;
  loadShellAsset: (spec: string) => Promise<{ default: BuildShellEntry }>;
}

declare global {
  // Injected into the built RSC entry by the shell prerender phase
  // (vite/discovery/shell-prerender-phase.ts): lazy loader for the shell
  // manifest module.
  // eslint-disable-next-line no-var
  var __loadShellManifestModule:
    | (() => Promise<ShellManifestModule>)
    | undefined;
}

let manifestPromise: Promise<ShellManifestModule | null> | null = null;

function loadManifest(): Promise<ShellManifestModule | null> {
  if (!manifestPromise) {
    const loader = globalThis.__loadShellManifestModule;
    if (!loader) return Promise.resolve(null);
    // A failing import is memoized as absent: the module is a build artifact,
    // so the failure is deterministic — retrying per request only re-pays it.
    manifestPromise = loader().catch(() => null);
  }
  return manifestPromise;
}

/**
 * Per-spec verdict memo for the version + integrity gates. A manifest record
 * is immutable for the process lifetime (content-hashed asset module), so its
 * gate verdict is constant — without this, EVERY request to a baked ppr route
 * re-decodes the full prelude base64 (hasIntactShellPayload) on the hot path:
 * a fresh build hit never populates the runtime store, so the store MISS +
 * read-through is the steady state, not a warm-up. Only the per-request
 * gates (tag markers, staleness) stay outside the memo. `null` memoizes a
 * failed verdict — deterministically invalid, don't re-pay the decode.
 * Spec-only keying is sound because buildVersion is process-constant on the
 * manifest path (folded into the shipped worker; dev never loads a manifest).
 */
const validatedSpecs = new Map<string, BuildShellEntry | null>();

async function validatedManifestRecord(
  mod: ShellManifestModule,
  spec: string,
  buildVersion: string,
): Promise<BuildShellEntry | undefined> {
  let verdict = validatedSpecs.get(spec);
  if (verdict === undefined) {
    const record = (await mod.loadShellAsset(spec)).default;
    verdict =
      isValidShellHit(record.entry, buildVersion) &&
      hasIntactShellPayload(record.entry)
        ? record
        : null;
    validatedSpecs.set(spec, verdict);
  }
  return verdict ?? undefined;
}

/** Reset the memoized manifest (unit tests swap the global loader). */
export function resetBuildShellManifestForTests(): void {
  manifestPromise = null;
  validatedSpecs.clear();
}

/** Keys already warned about a tag-check-incapable store (once per key). */
const warnedTagCheckUnsupported = new Set<string>();

export interface BuildShellHit {
  entry: ShellCacheEntry;
  /** Past createdAt + ttl: serve, but schedule the runtime recapture. */
  stale: boolean;
}

/**
 * Dev-mode lookup context: there is no build manifest in dev, so producer B
 * runs ON DEMAND through the Vite dev server's /__rsc_shell endpoint
 * (memoized per router HMR generation), mirroring the dev prerender store's
 * /__rsc_prerender flow. Only armed for PRERENDERED routes (matched.pr) —
 * exactly production's candidate set; everything else keeps runtime capture.
 */
export interface DevShellLookup {
  /** True when the classified route is trie-flagged pr (Prerender-backed). */
  isPrerenderRoute: boolean;
  /** Canonical route key of the classified route (endpoint verification). */
  routeName: string | undefined;
  /** Resolved ppr policy from the serve gate (the endpoint is policy-free). */
  ttl: number;
  swr?: number;
  tags?: string[];
  maxSnapshotBytes?: number;
  /** Resolved `ppr.captureTimeout` (ms) — the endpoint's capture honors it. */
  captureTimeout?: number;
}

/** Retry delay (~400ms) plus quiesce/fizz/store headroom past the budgets. */
const DEV_SHELL_RETRY_MARGIN_MS = 5_000;

/**
 * Dev boot-race readiness (issue #719). The `/__rsc_shell` endpoint stands up
 * the capture realm lazily on its first hit — the temp server (Cloudflare
 * preset), the registry import, and, on either preset, a Vite dependency
 * re-optimization that the first import of the shell-capture graph can trigger.
 * All three are TRANSIENT: retrying the same request seconds later succeeds.
 *
 * Before this, the read-through fired ONCE and mapped any non-2xx to a hard
 * MISS, so a Prerender+ppr route's FIRST request lost the race and served
 * axis-1 (x-rango-shell: MISS) while a later poll HIT — the build-time
 * first-request-HIT contract held only after a warm-up. A fast machine loses
 * the race deterministically (the document request beats the boot infra);
 * slow CI arrives after it settled, hence "0-flake on CI".
 *
 * Fix: the endpoint tags the transient not-ready branches with
 * `x-rango-shell-dev: NOT-READY` (HTTP 503), and the read-through re-polls
 * ONLY that signal — a bounded await of readiness, not a blind retry. A
 * genuine negative (route not prerenderable, capture refused: 404) stays an
 * immediate MISS, so a non-baked route never stalls the foreground. The window
 * is capped by DEV_SHELL_READINESS_DEADLINE_MS; the boot infra normally
 * settles well inside the first poll.
 */
const DEV_SHELL_NOT_READY = "NOT-READY";
const DEV_SHELL_READINESS_DEADLINE_MS = 10_000;
const DEV_SHELL_READINESS_POLL_MS = 150;

/**
 * Timed out like the dev prerender store fetch (see #697): inside a workerd
 * waitUntil an unsettled fetch pends forever instead of rejecting; on timeout
 * this degrades to a MISS and the runtime capture path takes over. But this
 * fetch blocks a foreground document request and its response IS an inline
 * capture, so the bound must cover the endpoint's FULL sequential worst case
 * — aborting a still-healthy capture turns it into a spurious MISS. The terms
 * of the server envelope (dev /__rsc_shell, vite/router-discovery.ts):
 * - DEV_SHELL_PROBE_TIMEOUT_MS: the sequential /__rsc_prerender pre-flight
 *   probe (same constant on the endpoint side).
 * - 2x the capture settle budget (`ppr.captureTimeout`, default
 *   SHELL_CAPTURE_MAX_WAIT_MS): first attempt + one in-place cold-graph retry.
 * - DEV_SHELL_RETRY_MARGIN_MS: the ~400ms retry delay plus headroom.
 * Deeper fix (possible follow-up): the endpoint owns ONE total deadline and
 * this bound becomes a plain liveness backstop instead of envelope math.
 */
function devShellFetchTimeoutMs(captureTimeout: number | undefined): number {
  return (
    DEV_SHELL_PROBE_TIMEOUT_MS +
    2 * (captureTimeout ?? SHELL_CAPTURE_MAX_WAIT_MS) +
    DEV_SHELL_RETRY_MARGIN_MS
  );
}

async function fetchDevShellEntry(
  pathname: string,
  buildVersion: string,
  dev: DevShellLookup,
): Promise<BuildShellEntry | undefined> {
  if (!dev.isPrerenderRoute || !dev.routeName) return undefined;
  const devUrl = globalThis.__PRERENDER_DEV_URL;
  if (!devUrl) return undefined;
  const params = new URLSearchParams({
    pathname,
    routeName: dev.routeName,
    ttl: String(dev.ttl),
    version: buildVersion,
  });
  if (dev.swr !== undefined) params.set("swr", String(dev.swr));
  if (dev.tags && dev.tags.length > 0) params.set("tags", dev.tags.join(","));
  if (dev.maxSnapshotBytes !== undefined) {
    params.set("maxSnapshotBytes", String(dev.maxSnapshotBytes));
  }
  if (dev.captureTimeout !== undefined) {
    params.set("captureTimeout", String(dev.captureTimeout));
  }
  const shellUrl = `${devUrl}/__rsc_shell?${params}`;
  // Await the endpoint's boot readiness (issue #719): re-poll ONLY the
  // NOT-READY signal, capped by DEV_SHELL_READINESS_DEADLINE_MS. Every other
  // outcome — a served entry, a genuine negative (404), or a network fault —
  // resolves on the first attempt, so a non-baked route never stalls here.
  const readinessDeadline = Date.now() + DEV_SHELL_READINESS_DEADLINE_MS;
  for (;;) {
    try {
      const res = await fetch(shellUrl, {
        signal: AbortSignal.timeout(devShellFetchTimeoutMs(dev.captureTimeout)),
      });
      if (
        res.status === 503 &&
        res.headers.get("x-rango-shell-dev") === DEV_SHELL_NOT_READY &&
        Date.now() < readinessDeadline
      ) {
        await new Promise((r) => setTimeout(r, DEV_SHELL_READINESS_POLL_MS));
        continue;
      }
      if (!res.ok) return undefined;
      return (await res.json()) as BuildShellEntry;
    } catch {
      return undefined;
    }
  }
}

/**
 * Look up the baked shell entry for a request, applying every serve gate:
 * search-less requests only (the build captured the bare pathname; a
 * search-bearing URL has its own shell identity owned by runtime capture),
 * version validity, payload integrity, and tag-invalidation markers. Returns
 * null on any gate failure — the caller degrades to the ordinary MISS path
 * (axis 1 + runtime capture), never a broken serve.
 */
export async function lookupBuildShell(
  url: URL,
  buildVersion: string,
  store: SegmentCacheStore,
  dev?: DevShellLookup,
): Promise<BuildShellHit | null> {
  try {
    // Source-presence first: with no manifest and no dev context this is the
    // steady-state MISS shape for every non-baked ppr route — return before
    // the searchParams sort/allocation below.
    const hasManifest = globalThis.__loadShellManifestModule !== undefined;
    if (!hasManifest && !dev) return null;
    if (sortedSearchString(url.searchParams) !== "") return null;
    let record: BuildShellEntry | undefined;
    if (hasManifest) {
      const mod = await loadManifest();
      if (!mod) return null;
      const spec = mod.default[buildShellManifestKey(url.pathname)];
      if (!spec) return null;
      record = await validatedManifestRecord(mod, spec, buildVersion);
    } else if (dev) {
      const fetched = await fetchDevShellEntry(url.pathname, buildVersion, dev);
      record =
        fetched !== undefined &&
        isValidShellHit(fetched.entry, buildVersion) &&
        hasIntactShellPayload(fetched.entry)
          ? fetched
          : undefined;
    }
    if (!record) return null;
    const entry = record.entry;
    if (record.tags && record.tags.length > 0) {
      const check = store.isTagsInvalidatedSince;
      if (typeof check !== "function") {
        // A tagged build entry on a store that cannot answer "was this tag
        // invalidated since the build" must not serve: updateTag() could
        // never evict it. Declared intent that cannot be honored deserves a
        // diagnostic; the route keeps runtime-capture semantics.
        const key = buildShellManifestKey(url.pathname);
        if (!warnedTagCheckUnsupported.has(key)) {
          warnedTagCheckUnsupported.add(key);
          console.warn(
            `[rango] Build-time shell for "${url.pathname}" carries cache tags, but ` +
              "the app cache store does not implement isTagsInvalidatedSince(), so " +
              "updateTag() could not evict it. The entry is not served; the route " +
              "keeps runtime shell capture. Use MemorySegmentCacheStore, CFCacheStore, " +
              "or VercelCacheStore (or add the method to your custom store).",
          );
        }
        return null;
      }
      if (await check.call(store, record.tags, entry.createdAt)) return null;
    }
    const stale = Date.now() >= entry.createdAt + record.ttl * 1000;
    return { entry, stale };
  } catch {
    // Any read-through fault is a MISS, never a 500 — the ordinary axis-1 +
    // runtime-capture path takes over.
    return null;
  }
}
