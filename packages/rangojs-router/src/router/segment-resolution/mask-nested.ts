/**
 * Capture-side nested-thenable masking — the mechanism behind "nested-promise
 * shape is the liveness declaration" for BOTH bake-lane loader containers
 * (loader-cache.ts) and pushed handle containers (request-context.ts
 * createUseFunction).
 *
 * Deliberately a LEAF module: request-context needs the mask for handle
 * pushes, and loader-mask (the other natural home) imports request-context —
 * importing from there would cycle. This module imports only is-thenable.
 */

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-copy a container with every NESTED thenable replaced by a masked
 * (never-resolving) promise. Applied during shell capture to (a) bake-lane
 * loader containers (loader-cache.ts) and (b) pushed handle containers
 * (createUseFunction) — the two rango-owned funnels where consumers declare
 * per-request data by promise SHAPE.
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
 * Only plain objects/arrays are traversed; other values are leaves. The INPUT
 * IS NEVER MUTATED — handler-side loader consumption (the consumption-lane
 * rule, semantic-matrix PPR3) shares the raw container and must keep real
 * values. Cycles are preserved as cycles in the copy.
 */
/**
 * Optional single-walk report for maskNestedContainerThenables: `thenable`
 * flips true when the walk masked at least one thenable. The shell fast path
 * reads it at handle-push time — a pushed container with a nested thenable
 * declares per-request data, and a shell entry whose HANDLER layer made such
 * a declaration cannot be served handler-free (the hole would never fill).
 * Same single-pass shape as elideLoaderContainer's `hasHole`.
 */
export interface MaskReport {
  thenable: boolean;
}

export function maskNestedContainerThenables(
  value: unknown,
  seen: Map<object, unknown> = new Map(),
  report?: MaskReport,
): unknown {
  if (isThenable(value)) {
    if (report) report.thenable = true;
    return createMaskedLoaderPromise();
  }

  if (Array.isArray(value)) {
    const cached = seen.get(value);
    if (cached !== undefined) return cached;
    const out: unknown[] = new Array(value.length);
    seen.set(value, out);
    for (let i = 0; i < value.length; i++) {
      out[i] = maskNestedContainerThenables(value[i], seen, report);
    }
    return out;
  }

  if (isPlainObject(value)) {
    const cached = seen.get(value);
    if (cached !== undefined) return cached;
    const out: Record<string, unknown> = {};
    seen.set(value, out);
    for (const key of Object.keys(value)) {
      out[key] = maskNestedContainerThenables(value[key], seen, report);
    }
    return out;
  }

  return value;
}
