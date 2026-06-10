/**
 * Handle Snapshot
 *
 * Capture and restore handle data for cached segments.
 * Handle data (breadcrumbs, metadata from ctx.use(Handle)) is collected
 * during segment resolution and stored alongside cached segments.
 */

import type { ResolvedSegment } from "../types.js";
import type { HandleStore } from "../server/handle-store.js";
import type { SegmentHandleData } from "./types.js";
import { serializeResult, deserializeResult } from "./segment-codec.js";

/**
 * Bound on the background cache-write encode of handle data. A pushed handle
 * value can be a Promise (request-context push-a-promise) or a Promise<ReactNode>
 * (Breadcrumbs content), which the Flight encoder awaits while draining. The
 * encode runs in waitUntil/runBackground, so a never-resolving handle value
 * would otherwise pin a background slot indefinitely; on timeout the entry's
 * handles coalesce to empty rather than hanging or poisoning the whole write.
 */
const HANDLE_ENCODE_TIMEOUT_MS = 5000;

type HandleRecord = Record<string, SegmentHandleData>;

// captureHandles builds a per-segment map keyed by every cached segment id, even
// segments that pushed nothing (their entry is an empty object). "No handle data"
// means no segment has any handle, in which case we skip the Flight encode and
// store an empty string — so the common handle-free route pays neither an encode
// on write nor a decode on every cache hit.
function hasHandleData(handles: HandleRecord): boolean {
  for (const segId in handles) {
    for (const _ in handles[segId]) return true;
  }
  return false;
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout), ms);
  });
  return Promise.race([
    p.then(
      (v) => {
        clearTimeout(timer);
        return v;
      },
      (e) => {
        clearTimeout(timer);
        throw e;
      },
    ),
    timeout,
  ]);
}

/**
 * Encode a captured handle map to a string for cache storage.
 *
 * Handle values can be Promises or React elements (e.g. Breadcrumbs `content`).
 * JSON.stringify destroys those (Promise -> {}, ReactNode non-representable), so
 * persisting the raw map silently corrupts non-scalar handle values on stores
 * that serialize to JSON (the Cloudflare cache). Routing the map through the same
 * RSC-Flight codec the segments/value already use awaits Promises and serializes
 * React elements, so the stored field is a lossless, JSON-safe string. The
 * in-memory store keeps the same string by reference, so both backends replay
 * identical decoded values.
 */
export async function encodeHandles(handles: HandleRecord): Promise<string> {
  // No handle was pushed anywhere — store an empty marker (decoded as "skip").
  if (!hasHandleData(handles)) return "";
  const encoded = await withTimeout(
    serializeResult(handles),
    HANDLE_ENCODE_TIMEOUT_MS,
    null,
  );
  // Encode failure/timeout coalesces to empty handles for this entry rather than
  // hanging or poisoning the whole cache write.
  return encoded ?? "";
}

/**
 * Decode a stored handle string back to a handle map. Returns null on any
 * decode failure (e.g. a cross-version entry read under a pinned static
 * version), so the caller can skip handle restore without discarding the
 * otherwise-valid cached segments alongside it.
 */
export async function decodeHandles(
  encoded: string,
): Promise<HandleRecord | null> {
  try {
    return await deserializeResult<HandleRecord>(encoded);
  } catch {
    return null;
  }
}

/**
 * Capture handle data for a set of segments from the handle store.
 * Used when caching segments to preserve their handle data.
 */
export function captureHandles(
  segments: ResolvedSegment[],
  handleStore: HandleStore,
): Record<string, SegmentHandleData> {
  const handles: Record<string, SegmentHandleData> = {};
  for (const seg of segments) {
    handles[seg.id] = handleStore.getDataForSegment(seg.id);
  }
  return handles;
}

/**
 * Restore handle data from a cached snapshot into the handle store.
 * Used when serving cached segments to replay their handle data.
 */
export function restoreHandles(
  handles: Record<string, SegmentHandleData>,
  handleStore: HandleStore,
): void {
  for (const [segId, segHandles] of Object.entries(handles)) {
    if (Object.keys(segHandles).length > 0) {
      handleStore.replaySegmentData(segId, segHandles);
    }
  }
}
