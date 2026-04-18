import type { ReactNode } from "react";

/**
 * Stable Promise wrappers keyed on the component itself. Objects (React
 * elements, functions, lazy payloads) land in a WeakMap so entries GC when
 * the underlying component is released; primitives (string, number, boolean,
 * null) land in a Map so memoization still applies to text-/null-backed
 * segments like those in partial-update flows. Keeping this cache outside
 * the segment eliminates preservation fields on ResolvedSegment — it survives
 * reconciliation naturally because the component ref is what's stable.
 *
 * Browser-only. On the server each SSR render needs a fresh pending promise
 * so Suspense can emit the loading fallback HTML before content streams. A
 * shared already-resolved promise has `.status === "fulfilled"` attached by
 * React on its first observation — subsequent `use()` calls return
 * synchronously without suspending, so the Suspense fallback never makes it
 * into the initial HTML. Route-definition components share refs across
 * requests, so a global cache would leak tracked state between renders.
 */
const IS_BROWSER = typeof window !== "undefined";
const objectContentCache = IS_BROWSER
  ? new WeakMap<object, Promise<ReactNode>>()
  : null;
const primitiveContentCache = IS_BROWSER
  ? new Map<unknown, Promise<ReactNode>>()
  : null;

/**
 * Return a stable Promise wrapping `component`, memoized on the component ref.
 *
 * A fresh `Promise.resolve(component)` each render would suspend for one
 * microtask and briefly commit the loading fallback inside Suspender — the
 * intercept / parallel-slot flicker this indirection prevents. Reusing the
 * same Promise ref keeps React's `use()` in "known fulfilled" state after
 * the first observation.
 *
 * @internal
 */
export function getMemoizedContentPromise(
  component: ReactNode,
): Promise<ReactNode> {
  if (component instanceof Promise) {
    return component as Promise<ReactNode>;
  }

  if (!objectContentCache || !primitiveContentCache) {
    return Promise.resolve(component);
  }

  if (component !== null && typeof component === "object") {
    const cached = objectContentCache.get(component);
    if (cached) {
      return cached;
    }
    const promise = Promise.resolve(component);
    objectContentCache.set(component, promise);
    return promise;
  }

  const cached = primitiveContentCache.get(component);
  if (cached) {
    return cached;
  }
  const promise = Promise.resolve(component);
  primitiveContentCache.set(component, promise);
  return promise;
}
