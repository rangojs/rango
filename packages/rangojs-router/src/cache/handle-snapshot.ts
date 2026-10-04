/**
 * Handle Snapshot
 *
 * Capture and restore handle data for cached segments.
 * Handle data (breadcrumbs, metadata from ctx.use(Handle)) is collected
 * during segment resolution and stored alongside cached segments.
 */

import { replayLoaderPush } from "./handle-capture.js";
import type { ResolvedSegment } from "../types.js";
import type { HandleStore, RecordAuthority } from "../server/handle-store.js";
import type { HandleOwners, SegmentHandleData } from "./types.js";
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

/**
 * `onError` reaches the Flight encode (see serializeResult). A cache writer
 * passes the collector it gives the value's encode, so a handle value that
 * fails to encode (a rejected pushed promise) refuses the whole entry like a
 * failed value does; prerender (prerender-match.ts) passes one too and
 * hands the error to its prerender.onError policy.
 */
export async function encodeHandles(
  handles: HandleRecord,
  onError?: (error: unknown) => void,
): Promise<string> {
  if (!hasHandleData(handles)) return "";
  return encodeHandleValue(handles, onError);
}

export function decodeHandles(encoded: string): Promise<HandleRecord | null> {
  return decodeHandleValue<HandleRecord>(encoded);
}

export async function encodeHandleValue(
  value: unknown,
  onError?: (error: unknown) => void,
): Promise<string> {
  const { serializeResult } = await import("./segment-codec.js");
  const encoded = await withTimeout(
    serializeResult(value, onError),
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
 * DSL-loader pushes stay out of the CACHE WRITE: a HIT runs loaders exactly
 * as an uncached render of the same request would (cache-lookup.ts
 * resolveFreshLoadersAndYield), so replaying a recorded copy would duplicate
 * the live push. Handler pushes, including
 * handler-invoked ctx.use(Loader) bodies (skipped with their handler on a
 * HIT), are kept. The store tags loader pushes by array position at push
 * time, so primitive values are covered. A PPR shell capture untags the
 * settled bake-lane pushes its record keeps (shell-capture.ts) and gives
 * them an owner (captureHandleOwners). Only this call site passes
 * excludeLoaderPushes; every other getDataForSegment consumer (the
 * render-barrier snapshot, prerender) sees every push.
 */
export function captureHandles(
  segments: ResolvedSegment[],
  handleStore: HandleStore,
): Record<string, SegmentHandleData> {
  const handles: Record<string, SegmentHandleData> = {};
  for (const seg of segments) {
    handles[seg.id] = handleStore.getDataForSegment(seg.id, true);
  }
  return handles;
}

/** The owners of captureHandles' values; undefined when none is owned. */
export function captureHandleOwners(
  segments: ResolvedSegment[],
  handleStore: HandleStore,
): HandleOwners | undefined {
  let owners: HandleOwners | undefined;
  for (const seg of segments) {
    const segOwners = handleStore.getRecordOwners(seg.id);
    if (segOwners) (owners ??= {})[seg.id] = segOwners;
  }
  return owners;
}

/**
 * captureHandles and captureHandleOwners cut down to the handle arrays that
 * hold an owned value, each whole (its unowned values too, in place), so
 * restoreHandles rebuilds exactly those arrays over a store that already
 * holds the rest. A prerender-served shell capture stores this: the
 * prerender store restores the handler pushes on a HIT, and the loader
 * pushes have no other record (shell-capture.ts captureAndStoreShell).
 */
export function captureOwnedHandles(
  segmentIds: Iterable<string>,
  handleStore: HandleStore,
): { handles: HandleRecord; owners?: HandleOwners } {
  const handles: HandleRecord = {};
  let owners: HandleOwners | undefined;
  for (const id of segmentIds) {
    const segOwners = handleStore.getRecordOwners(id);
    if (!segOwners) continue;
    const kept = handleStore.getDataForSegment(id, true);
    handles[id] = {};
    for (const name in segOwners) handles[id][name] = kept[name] ?? [];
    (owners ??= {})[id] = segOwners;
  }
  return { handles, owners };
}

/**
 * What the record being restored is to each loader's handle pushes on this
 * request (HandleStore RecordAuthority). Built by loaderPins (loader-cache.ts)
 * over the pins resolveLoaderData serves a loader's value from, so a value
 * and its record copies get one answer.
 */
export type OwnedPushDelivery = (loaderId: string) => RecordAuthority;

/**
 * Restore handle data from a cached snapshot into the handle store.
 * Used when serving cached segments to replay their handle data: a route
 * cache() record owns its segments' arrays, so it REPLACES them.
 *
 * A segment with `owners` is replaced with empty arrays and re-pushed in
 * recorded order. A loader-owned value stands (pushRestored) where `owned`
 * says the record supplies that loader's value too ("pin", "copies"), and is
 * a placeholder (pushPlaceholder) everywhere else: without `owned`, every
 * owner. Neither claims its loader, so the loader's own cache() HIT still
 * delivers (the thenable pushes a restored copy lets through, or its entry's
 * pushes in a placeholder's place).
 */
export function restoreHandles(
  handles: Record<string, SegmentHandleData>,
  handleStore: HandleStore,
  owners?: HandleOwners,
  owned?: OwnedPushDelivery,
): void {
  for (const [segId, segHandles] of Object.entries(handles)) {
    if (Object.keys(segHandles).length === 0) continue;
    const segOwners = owners?.[segId];
    if (!segOwners) {
      handleStore.replaySegmentData(segId, segHandles);
      continue;
    }
    const cleared: SegmentHandleData = {};
    for (const handleName in segHandles) cleared[handleName] = [];
    handleStore.replaySegmentData(segId, cleared);
    for (const [handleName, values] of Object.entries(segHandles)) {
      const valueOwners = segOwners[handleName];
      for (let i = 0; i < values.length; i++) {
        const owner = valueOwners?.[i];
        if (!owner) {
          handleStore.push(handleName, segId, values[i]);
          continue;
        }
        const authority = owned?.(owner);
        if (authority === "pin" || authority === "copies") {
          handleStore.pushRestored(handleName, segId, values[i], owner);
        } else {
          handleStore.pushPlaceholder(handleName, segId, values[i], owner);
        }
      }
    }
  }
}

/**
 * Append recorded handle pushes to the store, in recorded order, via push()
 * so active captures and loader-scope tagging see them like live pushes. For
 * a cached unit that shares its segments with live pushes ("use cache");
 * restoreHandles would wipe those. `segmentId` redirects every value to one
 * segment (the caller's).
 *
 * The replay of every cached unit that records by owner: a "use cache"
 * function (useCacheRecordKey) and a loader's own cache() (loader-cache.ts
 * recordOwnerKey, with `unitLoader` the cached loader).
 *
 * A `${seq}:${loaderId}` group is that loader's pushes, which reach the page
 * once per request: `claim` (setupLoaderAccess _claimLoaderPushes) is asked
 * once per loader and skips one that already ran or was replayed in this
 * request; a claimed loader that runs later replaces its replayed values
 * (HandleStore.pushReplayed). A group without an owner (`${seq}:`, or a key
 * without ":" from a record written before owner keys, which is a segment
 * id) is the unit's own: `unitLoader`'s, or no loader's for a function,
 * whose pushes are plain.
 *
 * The claimed loaders' placeholders give way to this delivery
 * (HandleStore.replacePlaceholders), `unitLoader`'s even when the entry
 * recorded no push for it: the entry stands for that loader's run.
 *
 * No `claim` means the caller's pushes are diverted off the page (a stale
 * refresh: cache-runtime.ts refreshView, setupLoaderAccess
 * _runLoaderIsolated): every group is delivered, into the diverting capture,
 * and the page's placeholders stay, or the page would lose the push.
 */
export function appendHandles(
  handles: Record<string, SegmentHandleData>,
  handleStore: HandleStore,
  segmentId: string | undefined,
  claim: ((loaderId: string) => boolean) | undefined,
  unitLoader?: string,
): void {
  const ownerOf = (key: string): string | undefined => {
    const colon = key.indexOf(":");
    return (colon < 0 ? "" : key.slice(colon + 1)) || unitLoader;
  };
  const claims = new Map<string, boolean>();
  const ask = (owner: string | undefined): void => {
    if (owner !== undefined && !claims.has(owner)) {
      claims.set(owner, claim ? claim(owner) : true);
    }
  };
  ask(unitLoader);
  for (const key in handles) ask(ownerOf(key));
  const deliver = (): void => {
    for (const [key, segHandles] of Object.entries(handles)) {
      const owner = ownerOf(key);
      if (owner !== undefined && !claims.get(owner)) continue;
      const target = segmentId ?? key;
      for (const [handleName, values] of Object.entries(segHandles)) {
        for (const value of values) {
          if (owner !== undefined) {
            replayLoaderPush(handleStore, handleName, target, value, owner);
          } else {
            handleStore.push(handleName, target, value);
          }
        }
      }
    }
  };
  const granted: string[] = [];
  if (claim) {
    for (const [owner, given] of claims) if (given) granted.push(owner);
  }
  handleStore.replacePlaceholders(granted, deliver);
}
