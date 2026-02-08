/**
 * Prerender Store
 *
 * Reads pre-rendered segment data injected into the worker bundle at build time.
 * The data is stored as globalThis.__PRERENDER_DATA, a JSON object keyed by
 * "<routeName>/<paramHash>".
 */

import type { SerializedSegmentData, SegmentHandleData } from "../cache/types.js";

export interface PrerenderEntry {
  segments: SerializedSegmentData[];
  handles: Record<string, SegmentHandleData>;
}

export interface PrerenderStore {
  get(routeName: string, paramHash: string): PrerenderEntry | null;
}

declare global {
  // Injected by closeBundle post-processing
  // eslint-disable-next-line no-var
  var __PRERENDER_DATA: Record<string, PrerenderEntry> | undefined;
}

/**
 * Create a prerender store backed by globalThis.__PRERENDER_DATA.
 * Returns null if no prerender data is available (dev mode or no prerendered routes).
 */
export function createPrerenderStore(): PrerenderStore | null {
  const data = globalThis.__PRERENDER_DATA;
  if (!data || Object.keys(data).length === 0) return null;

  return {
    get(routeName: string, paramHash: string): PrerenderEntry | null {
      const key = `${routeName}/${paramHash}`;
      return data[key] ?? null;
    },
  };
}
