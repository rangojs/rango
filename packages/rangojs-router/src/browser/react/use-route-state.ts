"use client";

import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { NavigationStoreContext } from "./context.js";
import type { EventController, RouteStateSignal } from "../event-controller.js";

/**
 * The value a reader rendered in React's last commit of it, written by its
 * layout effect. A page's release runs in the provider's layout effect, after
 * every reader's (children first), so it reads the commit that brings the
 * page.
 */
export function useCommitted<T>(value: T): { readonly current: T } {
  const committed = useRef(value);
  useLayoutEffect(() => {
    committed.current = value;
  }, [value]);
  return committed;
}

/**
 * Sets a route-state reader's value. `next` maps the value React ends on once
 * every set so far commits (`latest`) to the reader's value; `rebase` sets
 * `next` itself, so React recomputes it on whatever base it renders. The value
 * must not be a function.
 */
export type RouteStateSetter<T> = (
  next: (base: T) => T,
  signal?: RouteStateSignal,
  rebase?: boolean,
) => void;

/**
 * Route state a reader sets as the router store notifies it, in the lane of
 * the notification that carries it. A notification equal to `latest` sets
 * nothing, so a reader renders only when its value moves.
 *
 * A release is compared with what React committed, not with `latest`: while
 * React holds a page, its set is not on screen, and an urgent page that ends
 * the hold brings an equal value. A release that finds every set committed
 * with its value sets nothing.
 */
export function useRouteState<T>(
  init: () => T,
  same: (a: T, b: T) => boolean,
): [T, RouteStateSetter<T>] {
  const [value, setValue] = useState(init);
  const latest = useRef(value);
  const committed = useCommitted(value);
  const [set] = useState(
    (): RouteStateSetter<T> => (next, signal, rebase) => {
      const target = next(latest.current);
      if (signal === "release") {
        if (
          latest.current === committed.current &&
          same(target, latest.current)
        )
          return;
        latest.current = target;
        setValue((prev) => (same(prev, target) ? prev : target));
        return;
      }
      if (same(target, latest.current)) return;
      latest.current = target;
      setValue(rebase ? next : target);
    },
  );
  return [value, set];
}

/** The route a URL hook reads. */
export interface UrlRoute {
  location: URL;
  params: Record<string, string>;
}

const NO_ROUTE: UrlRoute = {
  location: new URL("/", "http://localhost"),
  params: Object.freeze({}) as Record<string, string>,
};

const routeOf = (controller: EventController): UrlRoute => ({
  location: controller.getState().location,
  params: controller.getParams(),
});

/**
 * A URL hook's value (usePathname, useParams, useSearchParams): `read` of the
 * route, seeded from the hydration snapshot while the document hydrates, then
 * set as the store notifies it and at a page's release (useRouteState). The
 * release rides the handle channel. `read` applies when the store changes,
 * never in a later render: a new one takes effect from the next change.
 *
 * A read equal to the value it is set over keeps that value, so an object
 * reader changes identity once per value: a release that ends a hold sets the
 * held page's object, which React's render of the held lane keeps.
 */
export function useUrlValue<T>(
  read: (route: UrlRoute) => T,
  same: (a: T, b: T) => boolean,
): T {
  const ctx = useContext(NavigationStoreContext);
  const [value, set] = useRouteState(() => {
    if (!ctx) return read(NO_ROUTE);
    const hydration = ctx.eventController.getHydrationSnapshot();
    return read(
      hydration
        ? { location: hydration.state.location, params: hydration.params }
        : routeOf(ctx.eventController),
    );
  }, same);
  const readRef = useRef(read);
  readRef.current = read;

  useEffect(() => {
    if (!ctx) return;
    const controller = ctx.eventController;
    const update = (signal?: RouteStateSignal): void => {
      const next = readRef.current(routeOf(controller));
      set((base) => (same(next, base) ? base : next), signal);
    };
    // Catch up with a change between the seeding render and this effect.
    update();
    const unsubscribe = controller.subscribe(update);
    const unsubscribeRelease = controller.subscribeToHandles((signal) => {
      if (signal === "release") update(signal);
    });
    return () => {
      unsubscribe();
      unsubscribeRelease();
    };
  }, []);

  return value;
}
