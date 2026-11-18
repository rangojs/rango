"use client";

import { useContext, useLayoutEffect, useState } from "react";
import type { Handle } from "../../handle.js";
import { isThenable } from "../../handles/is-thenable.js";
import { OutletContext } from "../../outlet-context.js";
import { NavigationStoreContext } from "./context.js";

/**
 * Push a handle's values from a client component, for the segment it renders
 * in: the client side of `ctx.use(handle)`.
 *
 * Call `push(value)` during render. What one render pushed is published by
 * that render's layout effect, so the values commit with the render that made
 * them: a render React throws away or that suspends publishes nothing. While
 * the component is mounted its values stand for the handle in its segment in
 * place of the server's; on unmount the server's show again. Server values in
 * other segments are untouched. The server renders nothing for it: a value the
 * first paint must show is pushed on the server too.
 *
 * Plain values only: a promise would bring back a settle-order race. One
 * mounted component per handle and segment.
 *
 * @example
 * ```tsx
 * "use client";
 * const { data } = useFetchLoader(ProjectLoader);
 * usePushHandle(Meta)({ title: data.name });
 * ```
 */
export function usePushHandle<T, A>(handle: Handle<T, A>): (value: T) => void {
  const controller = useContext(NavigationStoreContext)?.eventController;
  const segmentId = useContext(OutletContext)?.segment?.id;
  const [owner] = useState(() => ({}));
  const handleId = handle.$$id;
  // This render's list. Sealed once published: a push after the commit (an
  // event handler, an effect) would change values readers already took.
  const list: { values: T[]; sealed: boolean } = { values: [], sealed: false };

  useLayoutEffect(() => {
    if (!controller || segmentId === undefined) return;
    return () =>
      controller.setClientHandle(handleId, segmentId, owner, undefined);
  }, [controller, handleId, segmentId]);

  useLayoutEffect(() => {
    list.sealed = true;
    if (!controller || segmentId === undefined) return;
    controller.setClientHandle(handleId, segmentId, owner, list.values);
  });

  return (value: T): void => {
    if (list.sealed) {
      throw new Error(
        `[rango] usePushHandle(${handleId}): push() after the render committed. Push during render.`,
      );
    }
    if (isThenable(value)) {
      throw new Error(
        `[rango] usePushHandle(${handleId}): a client push takes a plain value, not a promise. Push the value once it is there.`,
      );
    }
    list.values.push(value);
  };
}
