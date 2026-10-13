import { LOADER_SEGMENT_ID } from "../browser/react/filter-segment-order.js";
import type { HandleData } from "../server/handle-store.js";

/**
 * Which run pushed each handle value, so a partial response replaces only the
 * pushes of what it re-ran (#1103).
 *
 * A segment's handle bucket holds its handler's pushes and those of the
 * loaders registered on it: a loader pushes under its owning segment's id
 * (fresh.ts, revalidation.ts pin `_currentSegmentId`). A navigation or an
 * action response decides each of them on its own: the handler re-runs and a
 * loader whose revalidate() answers false keeps its data on the client. The
 * response carries only what re-ran, so replacing the whole bucket with it
 * dropped the pushes of the loader whose data the page still shows (the
 * document title, a breadcrumb), and a loader re-run under a handler that did
 * not re-run took the handler's pushes with it.
 *
 * The record rides in the snapshot itself, beside each handle, under a name
 * no handle has: `data[pushedByKey(h)][segmentId][i]` is the $$id of the
 * loader whose run pushed `data[h][segmentId][i]`, or null for the segment's
 * handler. A bucket without a loader push has no entry. Inside the snapshot it
 * crosses Flight and every clone and history-cache copy with the values;
 * collectHandleData reads a handle by its $$id, so no collect sees it.
 * resolveDeferredHandleValues keeps it aligned when it drops a value.
 */
const PUSHED_BY_SUFFIX = "\u0000pushedBy";

/** The snapshot key holding `handleName`'s pushedBy record. */
export function pushedByKey(handleName: string): string {
  return handleName + PUSHED_BY_SUFFIX;
}

/** True for a pushedBy record's key, false for a handle's. */
export function isPushedByKey(name: string): boolean {
  return name.endsWith(PUSHED_BY_SUFFIX);
}

/** `data` without its pushedBy records, as a reader outside the router sees it. */
export function withoutPushedBy(data: HandleData): HandleData {
  const out: HandleData = {};
  for (const name in data) {
    if (!isPushedByKey(name)) out[name] = data[name];
  }
  return out;
}

type PushedBy = readonly (string | null)[] | undefined;

const keysOf = (a: object | undefined, b: object | undefined): Set<string> =>
  new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);

/**
 * `target` with the buckets of the segments in `ids` taken from `source`.
 * A pushedBy record is a snapshot key like a handle's, so a bucket's values
 * and the record of the runs that pushed them always come from the same
 * snapshot. New containers; the value arrays are shared, as cloneHandleData
 * (navigation-store.ts) shares them.
 */
export function withSegmentHandles(
  target: HandleData,
  source: HandleData,
  ids: ReadonlySet<string>,
): HandleData {
  const out: HandleData = {};
  for (const name of keysOf(target, source)) {
    const buckets: Record<string, unknown[]> = {};
    for (const [id, values] of Object.entries(target[name] ?? {})) {
      if (!ids.has(id)) buckets[id] = values;
    }
    for (const [id, values] of Object.entries(source[name] ?? {})) {
      if (ids.has(id)) buckets[id] = values;
    }
    if (Object.keys(buckets).length > 0) out[name] = buckets;
  }
  return out;
}

/**
 * The handle data after a partial response's snapshot `incoming` (each stream
 * yield holds everything the response pushed so far). A segment outside
 * `segmentOrder` loses its buckets. In the others a value stands for the run
 * that pushed it: the segment's handler, or a loader `matched` registers on
 * the segment (`${shortCode}D${index}.${$$id}`, a loader's pushes being filed
 * under its shortCode; an id it does not register, a dependency or a loader a
 * handler read, counts as the handler's). A run that has values in the
 * response, or ran for it (`resolvedIds`: the handlers and loaders that ran),
 * replaces its values with the ones it delivered, nothing when it delivered
 * none. The other runs keep theirs in place, and the response's values take
 * the position of the first value they replace (the end when they replace
 * none). New containers throughout: an object a reader was handed (a history
 * entry's data) is never written to.
 *
 * A segment with no values of a handle takes, for each loader `matched`
 * registers on it that did not run, the values that loader pushed under a
 * segment the page leaves, a slot excepted: a clientUrls() layout() loader the
 * server held on a navigation between two routes of the layout
 * (client-urls/layout-loader-copies.ts), whose pushes the page filed under
 * the route it leaves.
 */
export function mergePartialHandleData(
  current: HandleData,
  incoming: HandleData,
  segmentOrder: readonly string[],
  matched: readonly string[],
  resolvedIds: readonly string[] | undefined,
): HandleData {
  // A run's key: a segment's id for its handler, `${segmentId}\0${$$id}` for
  // a loader (its segment id with the `D${index}.` marker replaced).
  const runKey = (id: string): string =>
    id.replace(LOADER_SEGMENT_ID, "\u0000");
  const inOrder = new Set(segmentOrder);
  const registered = new Set(matched.map(runKey));
  const ran = new Set(resolvedIds?.map(runKey));
  const out: HandleData = {};
  for (const name of keysOf(current, incoming)) {
    if (isPushedByKey(name)) continue;
    const byName = pushedByKey(name);
    const buckets: Record<string, unknown[]> = (out[name] = {});
    for (const segmentId of segmentOrder) {
      const run = (by: PushedBy, i: number): string => {
        const key = `${segmentId}\u0000${by?.[i]}`;
        return registered.has(key) ? key : segmentId;
      };
      let currentValues = current[name]?.[segmentId];
      let currentBy = current[byName]?.[segmentId] as PushedBy;
      if (!currentValues) {
        // A loader's values from a segment the page leaves; one that ran for
        // this response replaces them below, like any of its values. Never
        // from a slot (".@"): an intercept's or a parallel's own copy of the
        // loader pushed those.
        const carried: unknown[] = (currentValues = []);
        const carriedBy: (string | null)[] = [];
        for (const from in current[byName]) {
          if (inOrder.has(from) || from.includes(".@")) continue;
          current[byName][from].forEach((_, i, runs) => {
            const key = run(runs as PushedBy, i);
            if (key === segmentId) return;
            carried.push(current[name][from][i]);
            carriedBy.push(runs[i] as string);
          });
        }
        currentBy = carriedBy;
      }
      const incomingValues = incoming[name]?.[segmentId] ?? [];
      const incomingBy = incoming[byName]?.[segmentId] as PushedBy;
      const delivered = new Set(
        incomingValues.map((_, i) => run(incomingBy, i)),
      );
      const values: unknown[] = [];
      const by: (string | null)[] = [];
      let at = -1;
      currentValues.forEach((value, i) => {
        const key = run(currentBy, i);
        if (delivered.has(key) || ran.has(key)) {
          if (at < 0) at = values.length;
        } else {
          values.push(value);
          by.push(currentBy?.[i] ?? null);
        }
      });
      if (at < 0) at = values.length;
      values.splice(at, 0, ...incomingValues);
      by.splice(
        at,
        0,
        ...incomingValues.map((_, i) => incomingBy?.[i] ?? null),
      );
      if (values.length > 0) buckets[segmentId] = values;
      if (by.some((run) => run !== null)) (out[byName] ??= {})[segmentId] = by;
    }
  }
  return out;
}
