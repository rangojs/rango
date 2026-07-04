/**
 * Loader-family capture snapshot: elide + overlay for bake-lane loader
 * containers (docs/design/loader-container-bake.md).
 *
 * A loader on an entry with NO renderable loading() executes during shell
 * capture; its settled container bakes into the prelude while every promise
 * still pending at the quiet window postpones as a hole. To keep a HIT's fresh
 * payload byte-identical to that frozen prelude, the capture pins the container
 * in the shell snapshot:
 *
 *   - elide:   deep-walk the settled container; a SETTLED nested promise baked
 *              its value (physics: it won the quiet window), so it is pinned as
 *              that value; a PENDING nested promise is a hole, replaced by
 *              {@link LOADER_HOLE_MARKER}. The result is promise-free and
 *              Flight-serializable.
 *   - overlay: on a HIT the loader runs fresh (only the loader body can mint
 *              the live nested promises), then the recorded container is laid
 *              over it: recorded paths win (they are what the prelude froze),
 *              marker paths take the fresh run's value (the live hole), and
 *              fresh-only paths pass through (they cannot contradict prelude
 *              bytes that never rendered them).
 */

import { isThenable } from "../../handles/is-thenable.js";

/**
 * Marker object standing in for a pending nested promise in a recorded loader
 * container. Shape-checked (not identity-checked) because the record round-trips
 * through Flight serialization and a JSON-embedding store envelope.
 */
export const LOADER_HOLE_KEY = "$rangoLoaderHole" as const;

export interface LoaderHoleMarker {
  [LOADER_HOLE_KEY]: 1;
}

export function isLoaderHoleMarker(value: unknown): value is LoaderHoleMarker {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)[LOADER_HOLE_KEY] === 1
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Probe whether a promise is already settled without waiting for it: races it
 * against an immediately-resolved sentinel across two microtask hops (then
 * chaining means a resolved inner value needs one extra hop to surface).
 * Returns the settled state, or "pending" if it has not settled by then.
 */
async function probeSettled(
  p: PromiseLike<unknown>,
): Promise<
  | { state: "fulfilled"; value: unknown }
  | { state: "rejected" }
  | { state: "pending" }
> {
  const PENDING = Symbol("pending");
  // Two sentinel hops: Promise.resolve(p) adoption costs a microtask, so a
  // single-hop sentinel would misreport an already-fulfilled promise as pending.
  const sentinel = Promise.resolve()
    .then(() => undefined)
    .then(() => PENDING as unknown);
  try {
    const raced = await Promise.race([Promise.resolve(p), sentinel]);
    if (raced === PENDING) return { state: "pending" };
    return { state: "fulfilled", value: raced };
  } catch {
    return { state: "rejected" };
  }
}

export type ElideResult =
  | { state: "ok"; value: unknown }
  | { state: "rejected" };

/**
 * Deep-elide a settled bake-lane container for recording. Settled nested
 * promises are inlined (they baked); pending ones become hole markers; a
 * REJECTED nested promise poisons the record (error UI must never bake into a
 * shared shell) — the caller refuses the capture. Only plain objects/arrays are
 * traversed; anything else (Date, Map, class instance) is a pinned leaf.
 * Cycles are cut as pinned references (best effort — Flight rejects true
 * cycles later regardless).
 */
export async function elideLoaderContainer(
  value: unknown,
  seen: Set<object> = new Set(),
): Promise<ElideResult> {
  if (isThenable(value)) {
    const probed = await probeSettled(value);
    if (probed.state === "pending") {
      return { state: "ok", value: { [LOADER_HOLE_KEY]: 1 } };
    }
    if (probed.state === "rejected") return { state: "rejected" };
    return elideLoaderContainer(probed.value, seen);
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return { state: "ok", value };
    seen.add(value);
    const out: unknown[] = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      const r = await elideLoaderContainer(value[i], seen);
      if (r.state === "rejected") return r;
      out[i] = r.value;
    }
    return { state: "ok", value: out };
  }

  if (isPlainObject(value)) {
    if (seen.has(value)) return { state: "ok", value };
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const r = await elideLoaderContainer(value[key], seen);
      if (r.state === "rejected") return r;
      out[key] = r.value;
    }
    return { state: "ok", value: out };
  }

  return { state: "ok", value };
}

/**
 * Overlay a recorded (elided) container onto the fresh run's container for a
 * shell HIT. Recorded wins per path; hole markers take the fresh value (the
 * live nested promise); fresh-only object keys pass through. Where the shapes
 * disagree structurally, recorded wins wholesale — it is what the prelude
 * froze, and parity beats freshness inside the shell.
 */
export function overlayLoaderContainer(
  fresh: unknown,
  recorded: unknown,
): unknown {
  if (isLoaderHoleMarker(recorded)) return fresh;

  if (Array.isArray(recorded)) {
    const freshArr = Array.isArray(fresh) ? fresh : [];
    return recorded.map((item, i) => overlayLoaderContainer(freshArr[i], item));
  }

  if (isPlainObject(recorded)) {
    if (!isPlainObject(fresh)) {
      // Shape drift: still honor markers (holes fall back to undefined).
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(recorded)) {
        out[key] = overlayLoaderContainer(undefined, recorded[key]);
      }
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(recorded)) {
      out[key] = overlayLoaderContainer(fresh[key], recorded[key]);
    }
    for (const key of Object.keys(fresh)) {
      if (!(key in out)) out[key] = fresh[key];
    }
    return out;
  }

  return recorded;
}
