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
 *   - elide:   deep-walk the settled container; a PENDING nested promise is a
 *              hole, replaced by {@link LOADER_HOLE_KEY} — and since
 *              loader-cache masks every nested thenable at capture
 *              ({@link maskNestedContainerThenables}), nested promises are
 *              ALWAYS pending here for new captures. The SETTLED-marker branch
 *              below is legacy: it fires only if a settled thenable reaches
 *              elide anyway, and the overlay keeps decoding SETTLED markers
 *              from pre-mask snapshots. The result is promise-free and
 *              Flight-serializable.
 *   - overlay: on a HIT the loader runs fresh (only the loader body can mint
 *              the live nested promises), then the recorded container is laid
 *              over it: recorded paths win (they are what the prelude froze),
 *              hole-marker paths take the fresh run's value (the live hole),
 *              SETTLED-marker paths become Promise.resolve(pinned) — consumers
 *              wrote use(data.x) against a promise-shaped container, and
 *              handing them the raw value throws React #438 on every HIT (the
 *              storefront PDP regression) — and fresh-only paths pass through
 *              (they cannot contradict prelude bytes that never rendered them).
 */

import { isThenable } from "../../handles/is-thenable.js";
import { createMaskedLoaderPromise } from "./loader-mask.js";

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

/**
 * Marker wrapping the inlined value of a NESTED promise that settled during
 * capture. The value baked (physics), but the container key was a promise —
 * the overlay must hand consumers a Promise.resolve(value), not the raw value,
 * or an unconditional use(data.x) throws React #438 on every HIT. The ROOT
 * container is never wrapped: loader-cache overlays against the awaited fresh
 * container value.
 */
export const LOADER_SETTLED_KEY = "$rangoLoaderSettled" as const;

export interface LoaderSettledMarker {
  [LOADER_SETTLED_KEY]: 1;
  value: unknown;
  /**
   * Present when the pinned subtree contains hole markers. Computed once at
   * capture (elide already visits every node) so the per-HIT overlay never
   * rescans the pinned structure to pick its rehydration path.
   */
  holes?: 1;
}

export function isLoaderSettledMarker(
  value: unknown,
): value is LoaderSettledMarker {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)[LOADER_SETTLED_KEY] === 1
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

/**
 * Deep-copy a settled bake-lane container with every NESTED thenable replaced
 * by a masked (never-resolving) promise. Applied by loader-cache's capture
 * branch to the container the capture RENDER and the capture RECORD consume.
 *
 * Why: nested-promise SHAPE is the liveness declaration — a consumer that
 * returns `{ x: Promise }` is saying "x is per-request". The elide contract
 * below only kept that promise live if it happened to still be PENDING when
 * the capture's quiet window closed; the window waits for the slowest shared
 * material on the page (plus the bake-lane holdUntil), so any real data source
 * (a 5ms SQL read, a 200ms basket API) settles first, and its value was baked
 * into the SHARED shell and snapshot-pinned for every HIT — per-request data
 * frozen and served cross-session (found live: a storefront basket, carrying
 * the capturing session's basketId/customer identifiers, served to anonymous
 * visitors). Masking makes the consuming subtree postpone as a hole no matter
 * when the promise settles, so elide records a HOLE marker and every HIT
 * streams the fresh value: liveness by declaration, not by racing the window.
 *
 * Only plain objects/arrays are traversed (same rules as elideNested); other
 * values are leaves. The INPUT IS NEVER MUTATED — handler-side consumption
 * (the consumption-lane rule, semantic-matrix PPR3) shares the raw container
 * and must keep real values. Cycles are preserved as cycles in the copy.
 */
export function maskNestedContainerThenables(
  value: unknown,
  seen: Map<object, unknown> = new Map(),
): unknown {
  if (isThenable(value)) return createMaskedLoaderPromise();

  if (Array.isArray(value)) {
    const cached = seen.get(value);
    if (cached !== undefined) return cached;
    const out: unknown[] = new Array(value.length);
    seen.set(value, out);
    for (let i = 0; i < value.length; i++) {
      out[i] = maskNestedContainerThenables(value[i], seen);
    }
    return out;
  }

  if (isPlainObject(value)) {
    const cached = seen.get(value);
    if (cached !== undefined) return cached;
    const out: Record<string, unknown> = {};
    seen.set(value, out);
    for (const key of Object.keys(value)) {
      out[key] = maskNestedContainerThenables(value[key], seen);
    }
    return out;
  }

  return value;
}

export type ElideResult =
  | { state: "ok"; value: unknown; hasHole: boolean }
  | { state: "rejected" };

/**
 * Deep-elide a settled bake-lane container for recording. Settled nested
 * promises pin their value behind a settled marker (they baked, but consumers
 * hold a promise-shaped key); pending ones become hole markers; a REJECTED
 * nested promise poisons the record (error UI must never bake into a shared
 * shell) — the caller refuses the capture. Only plain objects/arrays are
 * traversed; anything else (Date, Map, class instance) is a pinned leaf.
 * Cycles are cut as pinned references (best effort — Flight rejects true
 * cycles later regardless).
 *
 * The ROOT container promise-chain unwraps with NO marker: loader-cache
 * overlays against the AWAITED fresh container, so the recorded root must be
 * the unwrapped structure. Everything below it goes through elideNested.
 */
export async function elideLoaderContainer(
  value: unknown,
  seen: Set<object> = new Set(),
): Promise<ElideResult> {
  if (isThenable(value)) {
    const probed = await probeSettled(value);
    if (probed.state === "pending") {
      return { state: "ok", value: { [LOADER_HOLE_KEY]: 1 }, hasHole: true };
    }
    if (probed.state === "rejected") return { state: "rejected" };
    return elideLoaderContainer(probed.value, seen);
  }
  return elideNested(value, seen);
}

async function elideNested(
  value: unknown,
  seen: Set<object>,
): Promise<ElideResult> {
  if (isThenable(value)) {
    const probed = await probeSettled(value);
    if (probed.state === "pending") {
      return { state: "ok", value: { [LOADER_HOLE_KEY]: 1 }, hasHole: true };
    }
    if (probed.state === "rejected") return { state: "rejected" };
    const inner = await elideNested(probed.value, seen);
    if (inner.state === "rejected") return inner;
    const marker: LoaderSettledMarker = inner.hasHole
      ? { [LOADER_SETTLED_KEY]: 1, value: inner.value, holes: 1 }
      : { [LOADER_SETTLED_KEY]: 1, value: inner.value };
    return { state: "ok", value: marker, hasHole: inner.hasHole };
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return { state: "ok", value, hasHole: false };
    seen.add(value);
    const out: unknown[] = new Array(value.length);
    let hasHole = false;
    for (let i = 0; i < value.length; i++) {
      const r = await elideNested(value[i], seen);
      if (r.state === "rejected") return r;
      out[i] = r.value;
      hasHole ||= r.hasHole;
    }
    return { state: "ok", value: out, hasHole };
  }

  if (isPlainObject(value)) {
    if (seen.has(value)) return { state: "ok", value, hasHole: false };
    seen.add(value);
    const out: Record<string, unknown> = {};
    let hasHole = false;
    for (const key of Object.keys(value)) {
      const r = await elideNested(value[key], seen);
      if (r.state === "rejected") return r;
      out[key] = r.value;
      hasHole ||= r.hasHole;
    }
    return { state: "ok", value: out, hasHole };
  }

  return { state: "ok", value, hasHole: false };
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

  if (isLoaderSettledMarker(recorded)) {
    const pinned = recorded.value;
    // Deep holes inside a settled container (capture-computed `holes` bit)
    // need the fresh promise's resolved value to fill them; a fully-pinned
    // container resolves immediately (the prelude already shows it — never
    // gate it on fresh latency). A rejecting fresh run degrades holes to
    // undefined instead of poisoning the pin.
    if (recorded.holes === 1) {
      return Promise.resolve(fresh).then(
        (freshValue) => overlayLoaderContainer(freshValue, pinned),
        () => overlayLoaderContainer(undefined, pinned),
      );
    }
    return Promise.resolve(overlayLoaderContainer(undefined, pinned));
  }

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
