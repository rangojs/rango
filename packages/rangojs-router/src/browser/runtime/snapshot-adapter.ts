/**
 * Client Segment Runtime - Snapshot Adapter
 *
 * Converts between RSC payload format (RscPayload/RscMetadata) and
 * the runtime's ServerPatch/RouteSnapshot types. This is the boundary
 * between the fetch layer and the reducer.
 *
 * Depends on types.ts and signatures.ts.
 */

import type { ResolvedSegment } from "../../types.js";
import type { RscPayload, RscMetadata, HandleData } from "../types.js";
import type {
  ServerPatch,
  RouteSnapshot,
} from "./types.js";
import { buildSignatureMap } from "./signatures.js";

// ---------------------------------------------------------------------------
// RscPayload → ServerPatch
// ---------------------------------------------------------------------------

/**
 * Convert an RSC payload response into a ServerPatch for the reducer.
 * The executor calls this after deserializing the RSC stream.
 */
export function payloadToPatch(payload: RscPayload): ServerPatch {
  const metadata = payload.metadata;
  if (!metadata) {
    // Fallback for empty metadata (shouldn't happen in practice)
    return {
      isPartial: false,
      matched: [],
      diff: [],
      segments: [],
    };
  }

  return {
    isPartial: metadata.isPartial ?? false,
    matched: metadata.matched ?? [],
    diff: metadata.diff ?? [],
    segments: metadata.segments ?? [],
    slots: metadata.slots,
    handles: metadata.handles,
    cachedHandleData: metadata.cachedHandleData,
    isError: metadata.isError,
  };
}

// ---------------------------------------------------------------------------
// Initial segments → RouteSnapshot
// ---------------------------------------------------------------------------

/**
 * Build the initial RouteSnapshot from the SSR payload.
 * Called once during initBrowserApp to create the first `state.current`.
 */
export function buildInitialSnapshot(
  url: string,
  segments: ResolvedSegment[],
  matched: string[],
  options?: {
    slots?: Record<string, import("../../types.js").SlotState>;
    handleData?: HandleData;
    interceptSourceUrl?: string | null;
    version?: string;
  }
): RouteSnapshot {
  const segmentIndex = new Map<string, number>();
  for (let i = 0; i < segments.length; i++) {
    segmentIndex.set(segments[i].id, i);
  }

  const cacheKeyValue = deriveCacheKey(url);

  return {
    key: cacheKeyValue,
    url,
    matched,
    segments,
    segmentIndex,
    signatures: buildSignatureMap(segments),
    interceptSegments: [],
    slots: options?.slots ?? {},
    handleData: options?.handleData,
    interceptSourceUrl: options?.interceptSourceUrl ?? undefined,
    version: options?.version,
    updatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Cache key derivation (centralized)
// ---------------------------------------------------------------------------

/**
 * Derive a cache key from a URL string.
 * pathname + search, no hash. Intercept routes get `:intercept` suffix.
 */
export function deriveCacheKey(
  url: string,
  interceptSourceUrl?: string | null
): string {
  try {
    const parsed = new URL(url, "http://localhost");
    const base = parsed.pathname + parsed.search;
    return interceptSourceUrl ? base + ":intercept" : base;
  } catch {
    return interceptSourceUrl ? url + ":intercept" : url;
  }
}

/**
 * Generate a history key from a URL. Same as deriveCacheKey but
 * matches the existing generateHistoryKey behavior.
 */
export function generateHistoryKeyFromUrl(url: string): string {
  return deriveCacheKey(url);
}
