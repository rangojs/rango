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

export { buildShellManifestKey };

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

/** Reset the memoized manifest (unit tests swap the global loader). */
export function resetBuildShellManifestForTests(): void {
  manifestPromise = null;
}

/** Keys already warned about a tag-check-incapable store (once per key). */
const warnedTagCheckUnsupported = new Set<string>();

export interface BuildShellHit {
  entry: ShellCacheEntry;
  /** Past createdAt + ttl: serve, but schedule the runtime recapture. */
  stale: boolean;
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
): Promise<BuildShellHit | null> {
  try {
    if (globalThis.__loadShellManifestModule === undefined) return null;
    if (sortedSearchString(url.searchParams) !== "") return null;
    const mod = await loadManifest();
    if (!mod) return null;
    const spec = mod.default[buildShellManifestKey(url.pathname)];
    if (!spec) return null;
    const record = (await mod.loadShellAsset(spec)).default;
    const entry = record.entry;
    if (!isValidShellHit(entry, buildVersion)) return null;
    if (!hasIntactShellPayload(entry)) return null;
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
