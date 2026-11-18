"use client";

import { useContext, useLayoutEffect, useState } from "react";
import type { Handle } from "../../handle.js";
import { isThenable } from "../../handles/is-thenable.js";
import { OutletContext } from "../../outlet-context.js";
import { NavigationStoreContext } from "./context.js";

/**
 * Push a handle's values from a client component: the client side of the
 * server's `ctx.use(handle)`, for data the client learns or changes after the
 * server rendered (`load()`, a fetch loader, a live value, a draft).
 *
 * The values belong to the segment the component renders in (its nearest
 * route, layout or slot) and show after the server's values of that segment,
 * in that position whatever arrives first; the handle's collect decides what
 * wins (a later Meta title, a breadcrumb with the same href). They show with
 * the render that pushed them: a render React discards or that suspends
 * publishes nothing, and an unmount removes them.
 *
 * `push(value)` adds to the render in progress, so call it during render.
 * Once that render commits, `push` throws: an effect, an event handler or a
 * child that re-renders on its own calls `usePushHandle` itself, or passes
 * the data down and pushes it in render. Plain values only: a promise throws,
 * since its settle order would decide what shows.
 *
 * The server never runs it: SSR, a PPR shell and a navigation's first paint
 * show the server's values. A value the first paint must show is pushed on
 * the server too.
 *
 * @example
 * ```tsx
 * "use client";
 * function ChatTitle() {
 *   const { data } = useFetchLoader(ChatLoader);
 *   usePushHandle(Meta)({ title: `${data.unread} unread` });
 *   return null;
 * }
 * ```
 */
export function usePushHandle<T, A>(handle: Handle<T, A>): (value: T) => void {
  // `pushed` must be new on every render: the React Compiler, which an app
  // can apply to the router too, would keep one across renders.
  "use no memo";
  const controller = useContext(NavigationStoreContext)?.eventController;
  const segmentId = useContext(OutletContext)?.segment?.id;
  const [owner] = useState((): { warned?: boolean } => ({}));
  const handleId = handle.$$id;
  // This render's values; sealed once its commit published them.
  const pushed: { values: T[]; sealed?: boolean } = { values: [] };

  // Removes the values when the component unmounts or moves to another
  // handle or segment.
  useLayoutEffect(() => {
    if (!controller || segmentId === undefined) return;
    return () =>
      controller.setClientHandle(handleId, segmentId, owner, undefined);
  }, [controller, handleId, segmentId]);

  useLayoutEffect(() => {
    pushed.sealed = true;
    if (controller && segmentId !== undefined) {
      controller.setClientHandle(handleId, segmentId, owner, pushed.values);
    } else if (
      process.env.NODE_ENV !== "production" &&
      pushed.values.length > 0 &&
      !owner.warned
    ) {
      owner.warned = true;
      console.warn(
        `[rango] usePushHandle(${handleId}): rendered outside a route segment (no router or no layout, route or slot above it), so its values belong to no segment and are not applied. Render the component inside a route, layout or slot.`,
      );
    }
  });

  return (value: T): void => {
    if (pushed.sealed || isThenable(value)) {
      throw new Error(
        process.env.NODE_ENV === "production"
          ? `[rango] usePushHandle(${handleId}): push() ${pushed.sealed ? "after its render committed" : "of a promise"}`
          : pushed.sealed
            ? `[rango] usePushHandle(${handleId}): push() was called after the render that created it committed. Call push during the render of the component that called usePushHandle; an effect, an event handler or a child calls usePushHandle itself.`
            : `[rango] usePushHandle(${handleId}): push() takes a plain value, not a promise. Push the value once the data is there.`,
      );
    }
    pushed.values.push(value);
  };
}
