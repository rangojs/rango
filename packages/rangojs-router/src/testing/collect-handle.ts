/**
 * collectHandle — unit-test a handle's `collect`/accumulator function directly.
 *
 * A handle's collect function (the `createHandle(collect)` argument that maps the
 * per-segment pushed values into the accumulated result) is otherwise not
 * directly reachable: createHandle keeps it in a private registry keyed by the
 * handle's `$$id` and returns only `{ __brand, $$id }`. This primitive runs that
 * REAL registered collect on per-segment values you provide and returns the
 * accumulated result — so the mapper/accumulator is unit-testable without a full
 * route match.
 *
 * It relies on createHandle registering the collect even in a bare test (it
 * assigns a runtime fallback id when the Vite plugin did not inject one). If a
 * handle's module was never imported (so createHandle never ran), the collect is
 * unregistered and this falls back to a flat array with a warning.
 */

import { getCollectFn, type Handle } from "../handle.js";

export function collectHandle<TData, TAccumulated>(
  handle: Handle<TData, TAccumulated>,
  segments: ReadonlyArray<ReadonlyArray<TData>>,
): TAccumulated {
  const collectFn = getCollectFn(handle.$$id) as
    | ((segments: TData[][]) => TAccumulated)
    | undefined;

  if (!collectFn) {
    console.warn(
      `[rango] collectHandle: handle "${handle.$$id}" has no registered collect ` +
        `function. Import the handle's module so createHandle() runs. Falling ` +
        `back to a flat array.`,
    );
    return segments.flat() as unknown as TAccumulated;
  }

  // Drop empty arrays matching production behavior (segment count/indices).
  const nonEmpty = segments.filter((seg) => seg.length > 0) as TData[][];
  return collectFn(nonEmpty);
}
