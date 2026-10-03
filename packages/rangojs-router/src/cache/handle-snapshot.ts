/**
 * Handle Snapshot
 *
 * Capture and restore handle data for cached segments.
 * Handle data (breadcrumbs, metadata from ctx.use(Handle)) is collected
 * during segment resolution and stored alongside cached segments.
 */

import { replayLoaderPush } from "./handle-capture.js";
import type { ResolvedSegment } from "../types.js";
import type { HandleStore } from "../server/handle-store.js";
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
 * Which loaders the request serves from a pin stored with the record being
 * restored: how restoreHandles delivers the record's loader-owned values.
 * Built by loaderPins (loader-cache.ts) over the seed resolveLoaderData reads
 * a loader's value from, so a value and its record copies get one answer.
 * Read when a record hits, not before: a navigation replay arms its seed
 * from the hit (CacheScope.lookupRouteDetailed).
 */
export interface OwnedPushDelivery {
  /** The request serves at least one loader from a pin. */
  readonly seeded: boolean;
  /**
   * The record supplies `loaderId`'s value: a registered loader the request
   * serves from its pin, or a dependency the route does not register while
   * every `ssr: false` loader of the route is pinned (one of them ran it at
   * capture, and the record does not say which).
   */
  pinned(loaderId: string): boolean;
  /** The registered loaders that are not pinned: holes on this request. */
  unpinned(): ReadonlySet<string>;
}

/**
 * Restore handle data from a cached snapshot into the handle store.
 * Used when serving cached segments to replay their handle data: a route
 * cache() record owns its segments' arrays, so it REPLACES them.
 *
 * A segment with `owners` is replaced with empty arrays and re-pushed in
 * recorded order. A loader-owned value is a copy of a push that loader made
 * in the run that wrote the record; whether it stands depends on where this
 * request takes that loader's value from (`owned`, the one-source rule,
 * docs/design/handle-push-ownership.md):
 *
 * - Pinned (`owned.pinned`): the record supplies the value too. The copy
 *   goes through pushRestored and stands: a run of that loader on this
 *   request (a promise-carrying `ssr: false` loader, one whose pin asks for a
 *   run) reads the store, and its settled pushes are dropped, not swapped in.
 *   Nothing is claimed, so the loader's own cache() HIT still replays the
 *   pushes the record could not keep (the thenable ones pushRestored lets
 *   through). The same on a document HIT, a navigation replay and a prefetch.
 * - Anything else is a placeholder: pushReplayed, unclaimed, and its loader
 *   a hole (HandleStore.markHoles). Its run's pushes replace it (#936), a
 *   run that ends without one drops it (settleLoaderRun), and its own
 *   cache() HIT delivers that entry's pushes in its place (redeliverReplays).
 *   That is every owner of a record without pins: a shell entry that lost
 *   them (a navigation-only entry, `maxSnapshotBytes`), a route cache()
 *   record, any record during a capture. Without `owned`, every owner.
 *
 * The holes are marked when the record has owners or the request is seeded:
 * a record without owners on an unseeded request restores as a plain replay,
 * as every record of a route without `ppr` does.
 */
export function restoreHandles(
  handles: Record<string, SegmentHandleData>,
  handleStore: HandleStore,
  owners?: HandleOwners,
  owned?: OwnedPushDelivery,
): void {
  let placeholders: Set<string> | undefined;
  if (owned && (owners || owned.seeded)) {
    handleStore.markHoles(owned.unpinned());
  }
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
        if (owned?.pinned(owner)) {
          handleStore.pushRestored(handleName, segId, values[i], owner);
          continue;
        }
        if (!placeholders?.has(owner)) {
          (placeholders ??= new Set()).add(owner);
          handleStore.markHoles([owner]);
        }
        handleStore.pushReplayed(handleName, segId, values[i], owner);
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
 * Owner-keyed groups (useCacheRecordKey, `${seq}:${loaderId}`) are a loader's
 * pushes, which reach the page once per request: `claim` (setupLoaderAccess
 * _claimLoaderPushes) skips a loader that already ran or was replayed in this
 * request, and a claimed loader that runs later replaces its replayed values
 * (HandleStore.pushReplayed). A record's placeholders for a claimed loader
 * (restoreHandles leaves them unclaimed) give way to this entry's copies
 * (HandleStore.redeliverReplays), so the push shows once. Not without
 * `claim`: a stale refresh's pushes are diverted (cache-runtime.ts
 * refreshView), and removing the page's placeholders for them would leave
 * the page without the push. `${seq}:` groups are the function's own pushes.
 * A key without ":" is a segment id (records written before owner keys) and
 * replays unchanged. A loader's own cache() replays through loader-cache.ts
 * replayLoaderHandles.
 */
export function appendHandles(
  handles: Record<string, SegmentHandleData>,
  handleStore: HandleStore,
  segmentId?: string,
  claim?: (loaderId: string) => boolean,
): void {
  let claims: Map<string, boolean> | undefined;
  const claimed = (owner: string): boolean => {
    let deliver = claims?.get(owner);
    if (deliver === undefined) {
      deliver = claim ? claim(owner) : true;
      (claims ??= new Map()).set(owner, deliver);
    }
    return deliver;
  };
  const ownerOf = (key: string): string => {
    const colon = key.indexOf(":");
    return colon < 0 ? "" : key.slice(colon + 1);
  };
  const deliver = (): void => {
    for (const [key, segHandles] of Object.entries(handles)) {
      const owner = ownerOf(key);
      if (owner && !claimed(owner)) continue;
      const target = segmentId ?? key;
      for (const [handleName, values] of Object.entries(segHandles)) {
        for (const value of values) {
          if (owner) {
            replayLoaderPush(handleStore, handleName, target, value, owner);
          } else {
            handleStore.push(handleName, target, value);
          }
        }
      }
    }
  };
  if (!claim) {
    deliver();
    return;
  }
  let granted: string[] | undefined;
  for (const key in handles) {
    const owner = ownerOf(key);
    if (owner && !claims?.has(owner) && claimed(owner)) {
      (granted ??= []).push(owner);
    }
  }
  if (granted) handleStore.redeliverReplays(granted, deliver);
  else deliver();
}
