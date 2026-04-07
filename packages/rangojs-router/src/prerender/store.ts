/**
 * Prerender Store
 *
 * Reads pre-rendered segment data from the worker bundle at build time.
 * The manifest module is lazily loaded via globalThis.__loadPrerenderManifestModule,
 * a function injected into the RSC entry that returns the manifest module
 * containing a key-to-specifier map and a `loadPrerenderAsset` function
 * that anchors import() resolution relative to the manifest file.
 */

import type {
  SerializedSegmentData,
  SegmentHandleData,
} from "../cache/types.js";

export interface PrerenderEntry {
  segments: SerializedSegmentData[];
  handles: Record<string, SegmentHandleData>;
}

export interface PrerenderStore {
  get(
    routeName: string,
    paramHash: string,
    meta?: { pathname: string; isPassthroughRoute?: boolean },
  ): PrerenderEntry | null | Promise<PrerenderEntry | null>;
}

export interface StaticEntry {
  encoded: string;
  handles: Record<string, unknown[]>;
}

export interface StaticStore {
  get(handlerId: string): Promise<StaticEntry | null>;
}

interface PrerenderManifestModule {
  default: Record<string, string>;
  loadPrerenderAsset: (
    specifier: string,
  ) => Promise<{ default: PrerenderEntry }>;
}

declare global {
  // Injected by closeBundle post-processing: lazy loader for the prerender
  // manifest module. The module exports a key→specifier map and a
  // loadPrerenderAsset function that anchors import() relative to the manifest.
  // eslint-disable-next-line no-var
  var __loadPrerenderManifestModule:
    | (() => Promise<PrerenderManifestModule>)
    | undefined;
  // Injected by closeBundle post-processing: map of handlerId -> () => import("./assets/__st-*.js")
  // Asset default export is either a string (no handles) or { encoded, handles } object.
  // eslint-disable-next-line no-var
  var __STATIC_MANIFEST:
    | Record<string, () => Promise<{ default: string | StaticEntry }>>
    | undefined;
  // Injected by virtual module in dev mode for on-demand prerender
  // eslint-disable-next-line no-var
  var __PRERENDER_DEV_URL: string | undefined;
}

/**
 * Create a dev-mode prerender store that fetches on-demand from the
 * Vite dev server's /__rsc_prerender endpoint (runs in Node.js where
 * node:fs works, unlike workerd).
 */
export function createDevPrerenderStore(devUrl: string): PrerenderStore {
  return {
    async get(routeName, paramHash, meta) {
      if (!meta?.pathname) return null;
      const isIntercept = paramHash.endsWith("/i");
      let url = `${devUrl}/__rsc_prerender?pathname=${encodeURIComponent(meta.pathname)}&routeName=${encodeURIComponent(routeName)}`;
      if (isIntercept) url += "&intercept=1";
      if (meta.isPassthroughRoute) url += "&passthrough=1";
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        return res.json();
      } catch {
        return null;
      }
    },
  };
}

/**
 * Create a prerender store.
 * Dev mode: on-demand fetch from Vite dev server (node:fs works there).
 * Production: backed by globalThis.__loadPrerenderManifestModule which lazily
 * loads the manifest module on first access.
 * Returns null if no prerender data is available.
 */
export function createPrerenderStore(): PrerenderStore | null {
  if (globalThis.__PRERENDER_DEV_URL) {
    return createDevPrerenderStore(globalThis.__PRERENDER_DEV_URL);
  }
  if (!globalThis.__loadPrerenderManifestModule) return null;

  const cache = new Map<string, Promise<PrerenderEntry | null>>();
  let manifestModulePromise: Promise<PrerenderManifestModule | null> | null =
    null;

  function loadManifestModule(): Promise<PrerenderManifestModule | null> {
    if (!manifestModulePromise) {
      manifestModulePromise = globalThis.__loadPrerenderManifestModule!().catch(
        () => null,
      );
    }
    return manifestModulePromise;
  }

  return {
    get(routeName: string, paramHash: string): Promise<PrerenderEntry | null> {
      const key = `${routeName}/${paramHash}`;
      const cached = cache.get(key);
      if (cached) return cached;

      const promise = loadManifestModule().then((mod) => {
        if (!mod) return null;
        const specifier = mod.default[key];
        if (!specifier) return null;
        // Let asset load errors propagate — a missing/corrupted artifact
        // for a key that exists in the manifest is a build/deploy error
        // and should surface as a 500, not be silently swallowed as null
        // (which the handler stub would misreport as a 404).
        return mod.loadPrerenderAsset(specifier).then((asset) => asset.default);
      });
      cache.set(key, promise);
      return promise;
    },
  };
}

/**
 * Load the prerender manifest index for test introspection.
 * Returns the key→specifier map or null if unavailable.
 */
export async function loadPrerenderManifestIndex(): Promise<Record<
  string,
  string
> | null> {
  if (!globalThis.__loadPrerenderManifestModule) return null;
  try {
    const mod = await globalThis.__loadPrerenderManifestModule();
    return mod.default;
  } catch {
    return null;
  }
}

/**
 * Create a static segment store.
 * Production only: backed by globalThis.__STATIC_MANIFEST injected at build time.
 * Returns null if no static data is available (dev mode or no Static handlers).
 */
export function createStaticStore(): StaticStore | null {
  const manifest = globalThis.__STATIC_MANIFEST;
  if (!manifest || Object.keys(manifest).length === 0) return null;

  const cache = new Map<string, Promise<StaticEntry | null>>();

  return {
    get(handlerId: string): Promise<StaticEntry | null> {
      const cached = cache.get(handlerId);
      if (cached) return cached;

      const importFn = manifest[handlerId];
      if (!importFn) return Promise.resolve(null);

      const promise = importFn()
        .then((mod) => {
          const val = mod.default;
          // Normalize: string-only (no handles) or { encoded, handles }
          if (typeof val === "string") {
            return { encoded: val, handles: {} } as StaticEntry;
          }
          return val as StaticEntry;
        })
        .catch(() => null);
      cache.set(handlerId, promise);
      return promise;
    },
  };
}
