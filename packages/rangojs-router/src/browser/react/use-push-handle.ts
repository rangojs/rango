"use client";

import { useContext, useLayoutEffect, useState } from "react";
import type { Handle } from "../../handle.js";
import { OutletContext } from "../../outlet-context.js";
import type { ClientPushOwner } from "../../handles/client-pushes.js";
import { NavigationStoreContext } from "./context.js";

/**
 * Push a handle's values from a client component: the client side of the
 * server's `ctx.use(handle)`, for live data and live edits on the page (a
 * value from `load()` or a fetch loader, a live count, a draft).
 *
 * The values belong to the segment the component renders in (its nearest
 * route, layout or slot) and show after the server's values of that segment,
 * in that position whatever arrives first; the handle's collect decides what
 * wins (a later Meta title, a breadcrumb with the same href). Two components
 * that push one handle in one segment show in tree order; one nested inside
 * the other shows before it. They show with the render that pushed them: a
 * render React discards or that suspends publishes nothing, and an unmount
 * removes them.
 *
 * `push(value)` adds to the render in progress, so call it during render.
 * Once that render commits, `push` throws: an effect, an event handler or a
 * child that re-renders on its own calls `usePushHandle` itself, or passes
 * the data down and pushes it in render.
 *
 * `push(promise)` works as on the server: the value takes its place when it
 * is pushed, readers keep what they showed until it resolves, and one that
 * rejects or resolves to null or undefined is dropped. A promise is the same
 * value only as the same reference, so push a stable one (from a loader,
 * `load()` kept in state, or `useMemo`); a newer render's push or an unmount
 * drops a pending one's result.
 *
 * The values publish from a layout effect, which the server never runs: the
 * SSR document and a PPR shell show the server's values alone. On the client
 * they show in the commit of the render that pushed them, a navigation's
 * included.
 *
 * @example
 * ```tsx
 * "use client";
 * function ChatTitle() {
 *   const { data } = useFetchLoader(ChatLoader);
 *   const push = usePushHandle(Meta);
 *   if (data) push({ title: `${data.unread} unread` });
 *   return null;
 * }
 * ```
 */
export function usePushHandle<T, A>(
  handle: Handle<T, A>,
): (value: T | Promise<T | null | undefined>) => void {
  // `pushed` must be new on every render: the React Compiler, which an app
  // can apply to the router too, would keep one across renders.
  "use no memo";
  const controller = useContext(NavigationStoreContext)?.eventController;
  // The nearest provider that names a segment: a clientUrls group's page and
  // layouts render under OutletProviders with none (ClientUrlsRoot), inside
  // the group route's segment.
  let outlet = useContext(OutletContext);
  while (outlet && !outlet.segment) outlet = outlet.parent ?? null;
  const segmentId = outlet?.segment?.id;
  const [owner] = useState((): ClientPushOwner & { warned?: boolean } => ({}));
  // Renders this component again when another pusher of the handle joins
  // its segment (EventController.setClientHandle keeps them in tree order).
  const [generation, setGeneration] = useState(0);
  const handleId = handle.$$id;
  // This render's values; sealed once its commit published them.
  const pushed: {
    values: (T | Promise<T | null | undefined>)[];
    sealed?: boolean;
  } = {
    values: [],
  };

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
      owner.resync = () => setGeneration((n) => n + 1);
      owner.generation = generation;
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

  return (value: T | Promise<T | null | undefined>): void => {
    if (pushed.sealed) {
      throw new Error(
        process.env.NODE_ENV === "production"
          ? `[rango] usePushHandle(${handleId}): push() after its render committed`
          : `[rango] usePushHandle(${handleId}): push() was called after the render that created it committed. Call push during the render of the component that called usePushHandle; an effect, an event handler or a child calls usePushHandle itself.`,
      );
    }
    pushed.values.push(value);
  };
}
