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
import { hasIntactShellPayload, isValidShellHit } from "./shell-serve.js";
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
}

/**
 * Bound like the dev prerender store fetch (see #697): inside a workerd
 * waitUntil an unsettled fetch pends forever instead of rejecting; on
 * timeout this degrades to a MISS and the runtime capture path takes over.
 * 20s (not the store fetch's 10s): the endpoint's response IS an inline
 * capture — up to ~5s attempt + 400ms + ~5s cold-graph retry — and this
 * fetch blocks a foreground document request, so it must outlast a full
 * cold capture cycle rather than abort into a MISS at 10s.
 */
const DEV_SHELL_FETCH_TIMEOUT_MS = 20_000;

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
  try {
    const res = await fetch(`${devUrl}/__rsc_shell?${params}`, {
      signal: AbortSignal.timeout(DEV_SHELL_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    return (await res.json()) as BuildShellEntry;
  } catch {
    return undefined;
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
