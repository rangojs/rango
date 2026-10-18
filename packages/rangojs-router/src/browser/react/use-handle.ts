"use client";

import { useContext, useState, useEffect, useRef } from "react";
import type { Handle } from "../../handle.js";
import { collectHandleData } from "../../handle.js";
import type { HandleData } from "../types.js";
import { NavigationStoreContext } from "./context.js";
import { shallowEqual } from "./shallow-equal.js";
import type { RouteStateSignal } from "../event-controller.js";

/**
 * Hook to access collected handle data.
 *
 * Returns the collected value from all route segments that pushed to this handle.
 * Re-renders when handle data changes (navigation, actions).
 *
 * @param handle - The handle to read
 * @param selector - Optional selector for performance (only re-render when selected value changes)
 *
 * @example
 * ```tsx
 * // Get all breadcrumbs
 * const breadcrumbs = useHandle(Breadcrumbs);
 *
 * // With selector - only re-render when last crumb changes
 * const lastCrumb = useHandle(Breadcrumbs, (data) => data.at(-1));
 * ```
 */
export function useHandle<T, A>(handle: Handle<T, A>): Rango.FlightSerialize<A>;
export function useHandle<T, A, S>(
  handle: Handle<T, A>,
  selector: (data: Rango.FlightSerialize<A>) => S,
): S;
export function useHandle<T, A, S>(
  handle: Handle<T, A>,
  selector?: (data: Rango.FlightSerialize<A>) => S,
): Rango.FlightSerialize<A> | S {
  const ctx = useContext(NavigationStoreContext);

  const selectorRef = useRef(selector);
  selectorRef.current = selector;

  // Until every boundary has hydrated the store returns the state the
  // document's HTML was rendered with (EventController.lockHydration), so a
  // reader hydrating late reads what SSR rendered (issue #1035).
  const collect = (): Rango.FlightSerialize<A> | S => {
    const state = ctx?.eventController.getHandleState();
    const collected = collectHandleData(
      handle,
      state?.data ?? {},
      state?.segmentOrder ?? [],
    ) as Rango.FlightSerialize<A>;
    return selectorRef.current ? selectorRef.current(collected) : collected;
  };

  const [value, setValue] = useCommitAnchoredState(collect);

  useEffect(() => {
    if (!ctx) return;
    const update = (signal?: RouteStateSignal): void =>
      setValue(collect(), signal);
    // A (possibly new) handle on an idle page reads the current state.
    update();
    return ctx.eventController.subscribeToHandles(update);
  }, [handle]);

  return value;
}

/**
 * Route state the controller's handle notifications drive (useHandle,
 * useSegments) commits with the page it belongs to. NavigationProvider
 * flushes the controller inside every payload update, so a value known then
 * is set in the page's lane. A page handed over urgently (signal "release")
 * takes a value that arrives before it commits the same way: set at default
 * priority, it renders in the page's lane, and the page's effects read it.
 * A page in a transition (signal "anchor") does not: until it commits
 * (releaseRouteState() from the provider's layout effect, signal "release"),
 * a new value waits, and is applied in the commit's task, right after the
 * page's own commit. A newer anchor (a second click, an action over the held
 * page) sets only the change its own flush brings; a value that waited for
 * the earlier page waits on for the release. In the page's lane, a value
 * that suspends in a revealed <Suspense> (a crumb's content) would hold the
 * page; in a lane of its own, it commits over the page being left and takes
 * the page's transition types (#1165); and a transition entangled with the
 * page misses its commit when it is set after React rendered the page,
 * before its view transition's mutation, and starts a view transition of its
 * own. A value shallow-equal to the last one sets nothing, so a reader
 * renders only when its value moves.
 */
export function useCommitAnchoredState<T>(
  init: () => T,
): [T, (value: T, signal?: RouteStateSignal) => void] {
  // An app that enables the React Compiler compiles the router too; its memo
  // cache gains nothing here and cost 107 B gzip in the router chunk.
  "use no memo";
  const [value, setValue] = useState(init);
  const ref = useRef<{ last: T; held?: boolean; waiting?: boolean }>({
    last: value,
  });
  const [set] = useState(() => (next: T, signal?: RouteStateSignal): void => {
    const r = ref.current;
    const anchor = signal === "anchor";
    if (signal) r.waiting = anchor;
    const moved = !shallowEqual(next, r.last);
    if (moved) {
      r.last = next;
      r.held = true;
    }
    // Only the anchor's own change goes in the page's lane, with the page.
    if (!r.held || (r.waiting && !(anchor && moved))) return;
    r.held = false;
    // The value at dispatch: React runs an updater at render when the fiber
    // has another update pending, and by then r.last can hold a value that
    // waits.
    const v = r.last;
    setValue(() => v);
  });
  return [value, set];
}
