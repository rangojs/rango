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
// segment-codec eagerly pulls @vitejs/plugin-rsc (a virtual: module unresolvable
// in plain node/vitest). It is imported LAZILY inside the two async encode/decode
// helpers below so that modules which import handle-snapshot only for the
// plugin-rsc-free captureHandles/restoreHandles (e.g. cache-scope, on dispatch's
// lazy response-route cache path) do not pull plugin-rsc at module load. Behavior
// is unchanged: both helpers are async and already awaited the codec.

const HANDLE_ENCODE_TIMEOUT_MS = 5000;

type HandleRecord = Record<string, SegmentHandleData>;

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

export async function encodeHandles(handles: HandleRecord): Promise<string> {
  if (!hasHandleData(handles)) return "";
  return encodeHandleValue(handles);
}

export function decodeHandles(encoded: string): Promise<HandleRecord | null> {
  return decodeHandleValue<HandleRecord>(encoded);
}

export async function encodeHandleValue(value: unknown): Promise<string> {
  const { serializeResult } = await import("./segment-codec.js");
  const encoded = await withTimeout(
    serializeResult(value),
    HANDLE_ENCODE_TIMEOUT_MS,
    null,
  );
  return encoded ?? "";
}

/**
 * Decode a Flight-encoded handle-data string. Returns null on any decode
 * failure so the caller can skip handle restore without discarding valid
 * cached/prerendered segments.
 */
export async function decodeHandleValue<T>(encoded: string): Promise<T | null> {
  try {
    const { deserializeResult } = await import("./segment-codec.js");
    return await deserializeResult<T>(encoded);
  } catch {
    return null;
  }
}

/**
 * Capture handle data for a set of segments from the handle store.
 * Used when caching segments to preserve their handle data.
 *
 * `exclude` (shell captures: RequestContext._shellCaptureLoaderHandleValues)
 * drops DSL-loader-scoped push values from the CACHE WRITE only: loaders
 * re-run fresh on every HIT, so replaying their captured values would
 * duplicate the fresh push — and their masked nested promises would stall the
 * Flight handle encode to its timeout. Threaded as an explicit argument so
 * every other getDataForSegment consumer (the render-barrier snapshot,
 * prerender) provably sees every push.
 */
export function captureHandles(
  segments: ResolvedSegment[],
  handleStore: HandleStore,
  exclude?: WeakSet<object>,
): Record<string, SegmentHandleData> {
  const handles: Record<string, SegmentHandleData> = {};
  for (const seg of segments) {
    const data = handleStore.getDataForSegment(seg.id);
    if (!exclude) {
      handles[seg.id] = data;
      continue;
    }
    const filtered: SegmentHandleData = {};
    for (const [handleName, values] of Object.entries(data)) {
      const kept = values.filter(
        (v) => typeof v !== "object" || v === null || !exclude.has(v),
      );
      if (kept.length > 0) filtered[handleName] = kept;
    }
    handles[seg.id] = filtered;
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
