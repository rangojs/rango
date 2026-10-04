/**
 * Loader-family capture snapshot: elide + overlay for bake-lane loader
 * containers (docs/design/loader-container-bake.md).
 *
 * A bake-lane loader (lane rule: see resolveLoaderData, loader-cache.ts)
 * executes during shell capture; its settled container bakes into the prelude
 * while nested promises postpone as holes. To keep a HIT's fresh payload in
 * agreement with that frozen prelude, the capture pins the container in the
 * shell snapshot. Everything outside a hole is pinned; the one exception is a
 * server-component element holding a promise, which is a hole as a whole (see
 * elideLoaderContainer):
 *
 *   - elide:   deep-walk the settled container; a nested promise is a hole,
 *              replaced by {@link LOADER_HOLE_KEY}. loader-cache masks every
 *              nested thenable at capture ({@link maskNestedContainerThenables},
 *              a never-settling promise), so the promise shape alone decides:
 *              a value that settled in time does not bake (#692). The result
 *              is promise-free and Flight-serializable.
 *   - overlay: on a HIT the loader runs fresh (only the loader body can mint
 *              the live nested promises), then the recorded container is laid
 *              over it: recorded paths win (they are what the prelude froze),
 *              hole-marker paths take the fresh run's value (the live hole),
 *              and fresh-only paths pass through (they cannot contradict
 *              prelude bytes that never rendered them).
 */

import { isValidElement, type ReactElement } from "react";
import { isThenable } from "../../handles/is-thenable.js";
import {
  cloneElementWithProps,
  isPlainDataObject,
  maskNestedContainerThenables,
  type MaskReport,
} from "./mask-nested.js";

// Capture-side nested-thenable masking lives in the LEAF module mask-nested.ts
// (shared with the capture handle-store push wrap in rsc/shell-capture.ts).
// Re-exported here so loader-cache and the unit tests keep one import site for
// the snapshot family.
export { maskNestedContainerThenables };

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
  | { state: "ok"; value: unknown; hasHole: boolean }
  | { state: "rejected" };

/**
 * Deep-elide a settled bake-lane container for recording. Nested promises
 * become hole markers: the capture masked each of them (never settles), so
 * it postponed as a hole. A REJECTED container poisons the record (error UI
 * must never bake into a shared shell) — the caller refuses the capture.
 * Plain data objects, arrays and the props of host, Suspense/Fragment and
 * client-reference elements are
 * traversed copy-on-write (an element through cloneElementWithProps); a shared
 * subtree or a cycle resolves to the same elided result. An element Flight
 * renders by calling user code (see rendersOnServer) is a leaf, or ONE hole
 * marker when a thenable sits anywhere in its props: the pin encode calls that
 * component, so a marker inside its props would reach it. Anything else
 * (Date, Map, class instance, lazy node) is a pinned leaf.
 *
 * The ROOT container promise-chain unwraps with NO marker: loader-cache
 * overlays against the AWAITED fresh container, so the recorded root must be
 * the unwrapped structure. Everything below it goes through elideNested.
 */
export async function elideLoaderContainer(
  value: unknown,
  seen: Map<object, ElideResult> = new Map(),
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
  seen: Map<object, ElideResult>,
): Promise<ElideResult> {
  if (isThenable(value)) {
    return { state: "ok", value: { [LOADER_HOLE_KEY]: 1 }, hasHole: true };
  }
  if (typeof value !== "object" || value === null) {
    return { state: "ok", value, hasHole: false };
  }
  const cached = seen.get(value);
  if (cached) return cached;

  if (isValidElement<Record<string, unknown>>(value)) {
    if (rendersOnServer(value.type)) {
      return elementHoldsThenable(value.props)
        ? { state: "ok", value: { [LOADER_HOLE_KEY]: 1 }, hasHole: true }
        : { state: "ok", value, hasHole: false };
    }
    // Cached before the walk: a cycle back here pins the original.
    const result: ElideResult & { state: "ok" } = {
      state: "ok",
      value,
      hasHole: false,
    };
    seen.set(value, result);
    const props = value.props;
    let changed: Record<string, unknown> | undefined;
    for (const key of Object.keys(props)) {
      const r = await elideNested(props[key], seen);
      if (r.state === "rejected") return r;
      if (r.value !== props[key]) (changed ??= {})[key] = r.value;
      result.hasHole ||= r.hasHole;
    }
    if (changed) result.value = cloneElementWithProps(value, changed);
    return result;
  }

  if (Array.isArray(value) || isPlainDataObject(value)) {
    const source = value as Record<string, unknown>;
    const out = (Array.isArray(value) ? new Array(value.length) : {}) as Record<
      string,
      unknown
    >;
    // Cached before the walk: a cycle back here pins the copy.
    const result: ElideResult & { state: "ok" } = {
      state: "ok",
      value: out,
      hasHole: false,
    };
    seen.set(value, result);
    let changed = false;
    for (const key of Object.keys(source)) {
      const r = await elideNested(source[key], seen);
      if (r.state === "rejected") return r;
      out[key] = r.value;
      if (r.value !== source[key]) changed = true;
      result.hasHole ||= r.hasHole;
    }
    if (!changed) result.value = value;
    return result;
  }

  return { state: "ok", value, hasHole: false };
}

const CLIENT_REFERENCE = Symbol.for("react.client.reference");
const TEMPORARY_REFERENCE = Symbol.for("react.temporary.reference");
const REACT_MEMO = Symbol.for("react.memo");
const REACT_FORWARD_REF = Symbol.for("react.forward_ref");
const REACT_LAZY = Symbol.for("react.lazy");

/**
 * Whether Flight calls user code to encode an element of this type (its
 * renderElement): a function component, or a memo/forwardRef/lazy wrapper
 * around one. Host (string), Suspense/Fragment (symbol) and client-reference
 * types are encoded with their props as data, so a hole marker in those props
 * reaches no component. A lazy type is resolved the way Flight resolves it:
 * the Flight decode (a cache() hit, a "use cache" result) hands every client
 * component back as a lazy around its client reference, and the capture render
 * already resolved it. One that cannot resolve yet counts as a server
 * component.
 */
function rendersOnServer(type: unknown): boolean {
  if (typeof type !== "function" && (typeof type !== "object" || !type)) {
    return false;
  }
  const tag = (type as { $$typeof?: unknown }).$$typeof;
  if (tag === CLIENT_REFERENCE || tag === TEMPORARY_REFERENCE) return false;
  if (typeof type === "function") return true;
  if (tag === REACT_MEMO) {
    return rendersOnServer((type as { type?: unknown }).type);
  }
  if (tag === REACT_LAZY) {
    const resolved = readLazyNode(type);
    return resolved === UNRESOLVED || rendersOnServer(resolved);
  }
  return tag === REACT_FORWARD_REF;
}

/**
 * Whether the mask found a thenable in an element's props: the mask's own
 * walk, so elide and the mask share one traversal rule.
 */
function elementHoldsThenable(props: unknown): boolean {
  const report: MaskReport = { thenable: false };
  maskNestedContainerThenables(props, undefined, report);
  return report.thenable;
}

const UNRESOLVED: unique symbol = Symbol("unresolved");

function isLazyNode(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { $$typeof?: unknown }).$$typeof === REACT_LAZY
  );
}

/**
 * The value behind a lazy node, or UNRESOLVED. Flight moves an element past
 * ~3.2 KB of its row into a row of its own (`$L`), which the decode wraps in a
 * lazy node, so a hole marker inside that element sits behind one. The pinned
 * record is fully decoded when a HIT overlays it, so the read is synchronous;
 * a node that is still pending throws and stays a leaf.
 */
function readLazyNode(value: unknown): unknown {
  if (!isLazyNode(value)) return UNRESOLVED;
  const lazy = value as { _payload: unknown; _init: (p: unknown) => unknown };
  try {
    return lazy._init(lazy._payload);
  } catch {
    return UNRESOLVED;
  }
}

/**
 * Overlay a recorded (elided) container onto the fresh run's container for a
 * shell HIT. Recorded wins per path; hole markers take the fresh value (the
 * live nested promise); fresh-only object keys pass through. Where the shapes
 * disagree structurally, recorded wins wholesale — it is what the prelude
 * froze, and parity beats freshness inside the shell. Copy-on-write: a
 * recorded subtree without markers comes back by identity. A recorded element
 * is rebuilt through cloneElementWithProps only at its marker paths, so its
 * other props stay pinned; props the fresh element adds do not pass through
 * (the prelude rendered the element without them).
 */
export function overlayLoaderContainer(
  fresh: unknown,
  recorded: unknown,
): unknown {
  if (isLoaderHoleMarker(recorded)) return fresh;

  if (Array.isArray(recorded)) {
    const freshArr = Array.isArray(fresh) ? fresh : [];
    let out: unknown[] | undefined;
    for (let i = 0; i < recorded.length; i++) {
      const next = overlayLoaderContainer(freshArr[i], recorded[i]);
      if (next !== recorded[i]) (out ??= recorded.slice())[i] = next;
    }
    return out ?? recorded;
  }

  if (isValidElement<Record<string, unknown>>(recorded)) {
    return overlayElement(fresh, recorded);
  }

  const lazyValue = readLazyNode(recorded);
  if (lazyValue !== UNRESOLVED) {
    const next = overlayLoaderContainer(fresh, lazyValue);
    return next === lazyValue ? recorded : next;
  }

  if (isPlainDataObject(recorded)) {
    // Shape drift (fresh not a plain object): markers fall back to undefined.
    const freshObj = isPlainDataObject(fresh) ? fresh : undefined;
    let out: Record<string, unknown> | undefined;
    for (const key of Object.keys(recorded)) {
      const next = overlayLoaderContainer(freshObj?.[key], recorded[key]);
      if (next !== recorded[key]) (out ??= { ...recorded })[key] = next;
    }
    if (freshObj) {
      for (const key of Object.keys(freshObj)) {
        if (!(key in recorded)) (out ??= { ...recorded })[key] = freshObj[key];
      }
    }
    return out ?? recorded;
  }

  return recorded;
}

function overlayElement(
  fresh: unknown,
  recorded: ReactElement<Record<string, unknown>>,
): unknown {
  if (isLazyNode(fresh)) {
    // A fresh lazy node is read only when a recorded path needs the fresh
    // value: reading it parses a decoded row or calls a React.lazy factory
    // the HIT render never asks for otherwise.
    if (overlayProps(undefined, recorded) === recorded) return recorded;
    const read = readLazyNode(fresh);
    fresh = read === UNRESOLVED ? undefined : read;
  }
  return overlayProps(
    isValidElement<Record<string, unknown>>(fresh) ? fresh.props : undefined,
    recorded,
  );
}

function overlayProps(
  freshProps: Record<string, unknown> | undefined,
  recorded: ReactElement<Record<string, unknown>>,
): unknown {
  const props = recorded.props;
  let changed: Record<string, unknown> | undefined;
  for (const key of Object.keys(props)) {
    const next = overlayLoaderContainer(freshProps?.[key], props[key]);
    if (next !== props[key]) (changed ??= {})[key] = next;
  }
  return changed ? cloneElementWithProps(recorded, changed) : recorded;
}
