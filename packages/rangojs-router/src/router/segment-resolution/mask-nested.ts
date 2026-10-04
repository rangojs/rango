/**
 * Capture-side nested thenables. Masking is the mechanism behind "nested-
 * promise shape is the liveness declaration" for the loader lane: bake-lane
 * loader containers (loader-cache.ts) and DSL loader handle pushes (the
 * capture handle store's push wrap in rsc/shell-capture.ts). Handler handle
 * pushes are handler output and bake: the capture waits for their nested
 * promises instead (settleNestedThenables).
 *
 * Deliberately a LEAF module: loader-mask (the other natural home) imports
 * request-context, so any funnel importing the mask from there inherits that
 * graph. This module imports only is-thenable and react.
 */

import { cloneElement, isValidElement, type ReactElement } from "react";
import { isThenable } from "../../handles/is-thenable.js";

/**
 * A promise that never settles — the masked stand-in for a per-request value
 * during shell capture. The consuming Suspense subtree suspends forever, so
 * the static prerender postpones it as a hole instead of baking a per-request
 * value into the shared shell. The capture abort (`maxWaitMs` in
 * captureShellHTML) bounds how long the prerender waits before it freezes the
 * prelude, so this never hangs the request.
 */
export function createMaskedLoaderPromise<T = unknown>(): Promise<T> {
  return new Promise<T>(() => {});
}

/**
 * A data object the container walks descend into: prototype Object.prototype
 * or null, and no symbol `$$typeof`. React elements, lazy nodes and references
 * are plain objects too, told apart by that symbol (Flight switches on it).
 * They are React's, not data: an element's dev-only fields (`_debugStack`,
 * `_debugTask`, `_debugInfo`, `ref`) are non-enumerable, so a key-by-key copy
 * drops them and dev Flight refuses it ("Attempted to render <x> without
 * development properties", issue #942).
 */
export function isPlainDataObject(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return typeof (value as { $$typeof?: unknown }).$$typeof !== "symbol";
}

type KeyValidated = { _store?: { validated?: unknown } };

/**
 * cloneElement with only the given props replaced, keeping React's dev key
 * validation. React 19 dev cloneElement resets `_store.validated`, so a
 * keyless child of a static children list (validated at creation) would warn
 * "Each child in a list should have a unique key" once cloned. Pass only the
 * props that change: cloneElement re-parents the element (owner) when its
 * config carries `ref`.
 */
export function cloneElementWithProps(
  element: ReactElement,
  props: Record<string, unknown>,
): ReactElement {
  const clone = cloneElement(element, props);
  const from = (element as KeyValidated)._store;
  const to = (clone as KeyValidated)._store;
  if (from && to) to.validated = from.validated;
  return clone;
}

/**
 * Resolves once `value` and every thenable reachable from it through plain
 * data objects, arrays and React element props has settled, following what
 * each thenable resolves to. A rejection counts as settled: the consumer that
 * encodes the value reports it. Other objects are leaves (the same walk as
 * maskNestedContainerThenables), so a promise inside a Map is not waited for.
 * An element is walked through its props only (`<X data={promise} />` in a
 * handle value is handler output too), never its owner or type, and is never
 * rebuilt: nothing is copied, only awaited.
 *
 * The capture waits on this for HANDLER handle pushes (shell-capture.ts):
 * handler output is baked, so its promises must settle before the doc record
 * encodes the handles every HIT replays.
 */
export function settleNestedThenables(value: unknown): Promise<void> {
  const pending: Promise<void>[] = [];
  someNestedThenable(value, (thenable) => {
    pending.push(
      Promise.resolve(thenable).then(settleNestedThenables, () => undefined),
    );
    return false;
  });
  return pending.length === 0
    ? Promise.resolve()
    : Promise.all(pending).then(() => undefined);
}

/**
 * The walk settleNestedThenables and holdsThenable share: visit each thenable
 * reachable from `value` through plain data objects, arrays and React element
 * props (never an element's owner or type), the shapes
 * maskNestedContainerThenables masks; every other object is a leaf. Stops at
 * the first visit that returns true and reports whether one did.
 */
function someNestedThenable(
  value: unknown,
  visit: (thenable: PromiseLike<unknown>) => boolean,
): boolean {
  let seen: Set<object> | undefined;
  const walk = (v: unknown): boolean => {
    if (isThenable(v)) return visit(v);
    if (typeof v !== "object" || v === null) return false;
    if (isValidElement<Record<string, unknown>>(v)) return walk(v.props);
    if (!Array.isArray(v) && !isPlainDataObject(v)) return false;
    seen ??= new Set();
    if (seen.has(v)) return false;
    seen.add(v);
    // Own enumerable values, as maskNestedContainerThenables walks
    // Object.keys: an array's non-index properties are walked too.
    return Object.values(v).some(walk);
  };
  return walk(value);
}

/**
 * True when `value` is a thenable or holds one where the capture's loader
 * push funnel masks it (maskNestedContainerThenables): through plain data
 * objects, arrays and React element props. Such a push stays out of a shell's
 * record and reaches a HIT only from a run of its loader there, so a HIT
 * keeps it; a push without one is the record's (HandleStore.pushRestored).
 */
export function holdsThenable(value: unknown): boolean {
  return someNestedThenable(value, () => true);
}

/**
 * Optional single-walk report for maskNestedContainerThenables: `thenable`
 * flips true when the walk masked at least one thenable. The capture push
 * funnel reads it for a loader push: a container with a masked nested
 * promise keeps its loader tag, so the handle encode never waits on a mask.
 * Same single-pass shape as elideLoaderContainer's `hasHole`.
 */
export interface MaskReport {
  thenable: boolean;
}

/**
 * Copy a container with every NESTED thenable replaced by a masked
 * (never-resolving) promise. Applied during shell capture to (a) bake-lane
 * loader containers (loader-cache.ts) and (b) DSL loader handle pushes
 * (shell-capture.ts capture store push wrap) — the rango-owned funnels where
 * a loader declares per-request data by promise SHAPE.
 *
 * Why: a nested promise that happened to SETTLE before the capture's quiet
 * window closed used to bake its value into the SHARED shell (and, for
 * loaders, the snapshot pinned it for every HIT) — per-request data frozen
 * and served cross-session (found live: a storefront basket, carrying the
 * capturing session's basketId/customer identifiers, served to anonymous
 * visitors). The window waits for the slowest shared material on the page, so
 * any real data source (a 5ms SQL read, a 200ms basket API) lost the race.
 * Masking makes the consuming subtree postpone as a hole no matter when the
 * promise settles: liveness by declaration, not by racing the window.
 *
 * Plain data objects, arrays and React element props are traversed: JSX
 * carrying a promise (`<Reviews data={fetchReviews()} />`) declares
 * per-request data the same way a plain container does. Other values, lazy
 * nodes included, are leaves. Copy-on-write: a subtree without a thenable
 * comes back by identity, so an element is rebuilt only when its props hold
 * one, and then through cloneElementWithProps, which keeps its type, key,
 * owner, dev fields and key validation. The INPUT IS NEVER MUTATED: a handler
 * that reads the loader (`ctx.use`) reads the raw container and must keep
 * real values. Cycles are preserved as cycles in the copy.
 */
export function maskNestedContainerThenables(
  value: unknown,
  seen: Map<object, unknown> = new Map(),
  report?: MaskReport,
): unknown {
  if (isThenable(value)) {
    if (report) report.thenable = true;
    return createMaskedLoaderPromise();
  }
  if (typeof value !== "object" || value === null) return value;
  const cached = seen.get(value);
  if (cached !== undefined) return cached;

  if (isValidElement<Record<string, unknown>>(value)) {
    // Placeholder: a cycle back to this element through its props keeps the
    // original.
    seen.set(value, value);
    const props = value.props;
    let maskedProps: Record<string, unknown> | undefined;
    for (const key of Object.keys(props)) {
      const masked = maskNestedContainerThenables(props[key], seen, report);
      if (masked !== props[key]) (maskedProps ??= {})[key] = masked;
    }
    if (!maskedProps) return value;
    const clone = cloneElementWithProps(value, maskedProps);
    seen.set(value, clone);
    return clone;
  }

  if (Array.isArray(value) || isPlainDataObject(value)) {
    const source = value as Record<string, unknown>;
    const out = (Array.isArray(value) ? new Array(value.length) : {}) as Record<
      string,
      unknown
    >;
    seen.set(value, out);
    let changed = false;
    for (const key of Object.keys(source)) {
      out[key] = maskNestedContainerThenables(source[key], seen, report);
      if (out[key] !== source[key]) changed = true;
    }
    if (changed) return out;
    seen.set(value, value);
    return value;
  }

  return value;
}
