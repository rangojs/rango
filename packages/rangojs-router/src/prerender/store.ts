/**
 * Prerender Store
 *
 * Reads pre-rendered segment data from the worker bundle at build time.
 * The data is stored as globalThis.__PRERENDER_MANIFEST, a map of
 * "<routeName>/<paramHash>" to dynamic import functions that resolve
 * individual prerender entry modules.
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
    meta?: { pathname: string },
  ): PrerenderEntry | null | Promise<PrerenderEntry | null>;
}

export interface StaticEntry {
  encoded: string;
  handles: Record<string, unknown[]>;
}

export interface StaticStore {
  get(handlerId: string): Promise<StaticEntry | null>;
}

declare global {
  // Injected by closeBundle post-processing: map of key -> () => import("./assets/__pr-*.js")
  // eslint-disable-next-line no-var
  var __PRERENDER_MANIFEST:
    | Record<string, () => Promise<{ default: PrerenderEntry }>>
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
 * Production: backed by globalThis.__PRERENDER_MANIFEST injected at build time.
 * Returns null if no prerender data is available.
 */
export function createPrerenderStore(): PrerenderStore | null {
  if (globalThis.__PRERENDER_DEV_URL) {
    return createDevPrerenderStore(globalThis.__PRERENDER_DEV_URL);
  }
  const manifest = globalThis.__PRERENDER_MANIFEST;
  if (!manifest || Object.keys(manifest).length === 0) return null;

  const cache = new Map<string, Promise<PrerenderEntry | null>>();

  return {
    get(routeName: string, paramHash: string): Promise<PrerenderEntry | null> {
      const key = `${routeName}/${paramHash}`;
      const cached = cache.get(key);
      if (cached) return cached;

      const loader = manifest[key];
      if (!loader) return Promise.resolve(null);

      const promise = loader()
        .then((mod) => mod.default)
        .catch(() => null);
      cache.set(key, promise);
      return promise;
    },
  };
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
