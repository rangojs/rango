import type { ReactNode } from "react";
import type { ResolvedSegment } from "./types.js";

/**
 * Return a stable Promise wrapping `component`, memoized on `segment`.
 *
 * A fresh `Promise.resolve(component)` each render would suspend for one
 * microtask and briefly commit the loading fallback inside Suspender — the
 * intercept / parallel-slot flicker this indirection prevents. Reusing the
 * same Promise ref keeps React's `use()` in "known fulfilled" state after
 * the first observation. `component` is separate from `segment.component`
 * so action renders can feed in the awaited value.
 *
 * @internal
 */
export function getMemoizedContentPromise(
  segment: ResolvedSegment,
  component: ReactNode,
): Promise<ReactNode> {
  if (component instanceof Promise) {
    return component as Promise<ReactNode>;
  }
  if (
    segment.contentPromise !== undefined &&
    segment.contentSource === component
  ) {
    return segment.contentPromise;
  }
  const promise = Promise.resolve(component);
  segment.contentPromise = promise;
  segment.contentSource = component;
  return promise;
}
