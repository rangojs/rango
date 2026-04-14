import type { ReactNode } from "react";
import type { ResolvedSegment } from "./types.js";

/**
 * Return a stable Promise wrapping `component`, memoized on `segment`.
 *
 * When `component` is already a Promise, returns it directly. Otherwise,
 * returns a memoized `Promise.resolve(component)` whose identity persists
 * across renders (stashed on the segment) so React's `use()` inside
 * Suspender recognises it as already-fulfilled after the first observation.
 * Without this, a fresh `Promise.resolve` each render would suspend for one
 * microtask and briefly commit the loading fallback — the intercept /
 * parallel-slot flicker this indirection is here to prevent.
 *
 * Takes `component` as a parameter (instead of reading `segment.component`)
 * so `renderSegments` can feed in the awaited resolvedComponent during
 * actions without having to mutate the segment.
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
