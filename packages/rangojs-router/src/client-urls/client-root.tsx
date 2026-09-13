"use client";

import {
  createElement,
  Fragment,
  Suspense,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Outlet } from "../client.js";
import { OutletProvider } from "../outlet-provider.js";
import { useMount } from "../browser/react/use-mount.js";
import {
  registerClientUrlGroup,
  type ClientUrlNavigationIntent,
} from "./navigation.js";
import {
  OptimisticLocationContext,
  type OptimisticLocation,
} from "./optimistic-location.js";
import type {
  ClientUrlInterceptRecord,
  ClientUrlPatterns,
  ClientUrlRouteRecord,
} from "./types.js";

const PENDING_FOREVER: Promise<never> = new Promise<never>(() => {});

function findRoute(
  definition: ClientUrlPatterns,
  routeId: string,
): ClientUrlRouteRecord {
  const route = definition.routes.find((candidate) => candidate.id === routeId);
  if (!route) {
    throw new Error(
      `Client URL route mismatch: route id "${routeId}" was not found in the provided definition`,
    );
  }
  return route;
}

function findIntercept(
  definition: ClientUrlPatterns,
  interceptIndex: number,
): ClientUrlInterceptRecord {
  const record = definition.intercepts[interceptIndex];
  if (!record) {
    throw new Error(
      `Client URL intercept mismatch: intercept index ${interceptIndex} was not found in the provided definition`,
    );
  }
  return record;
}

/**
 * Server-materialized wrapper layout for a clientUrls() group that declares
 * intercepts. Attachment scar: intercepts emitted at the TOP LEVEL of a lazily
 * included module attach to the isolated parent clone
 * (getIsolatedLazyParent in server/context.ts) and are silently discarded —
 * only intercepts attached to a layout entry created WITHIN the expansion
 * survive in origin chains. Materialization therefore wraps the group's routes
 * and intercept entries in this layout; it renders the child outlet plus one
 * named outlet per declared slot, so the modal presents inside the group's own
 * subtree (module-local declaration, module-local presentation).
 */
export function ClientUrlsGroupLayout({
  slotNames,
}: {
  slotNames: readonly `@${string}`[];
}): ReactNode {
  return (
    <Fragment>
      <Outlet />
      {slotNames.map((name) => (
        <Outlet key={name} name={name} />
      ))}
    </Fragment>
  );
}

/** Slot content for a client-declared intercept: renders the definition's
 *  modal component; its useLoader() calls read the slot segment's loader data
 *  from the surrounding outlet context. */
export function ClientUrlsInterceptSlot({
  definition,
  interceptIndex,
}: {
  definition: ClientUrlPatterns;
  interceptIndex: number;
}): ReactNode {
  const record = findIntercept(definition, interceptIndex);
  return createElement(record.component, {
    key: `intercept-${interceptIndex}`,
  });
}

export function ClientUrlsInterceptLoading({
  definition,
  interceptIndex,
}: {
  definition: ClientUrlPatterns;
  interceptIndex: number;
}): ReactNode {
  return findIntercept(definition, interceptIndex).loading ?? null;
}

export function ClientUrlsRoot({
  definition,
  routeId,
  namePrefix = "",
}: {
  definition: ClientUrlPatterns;
  routeId: string;
  /** include() route-name prefix, injected at materialization for canonical
   *  name composition (intercept-target coordination). */
  namePrefix?: string;
}): ReactNode {
  // The include() mount prefix this group renders under ("/" at root). The
  // module trie is built from definition-LOCAL patterns; navigation strips
  // this prefix before matching (see stripMountPrefix in navigation.ts), the
  // same way client href()/useMount resolve include-relative URLs.
  const mount = useMount();
  const [intent, setIntent] = useState<ClientUrlNavigationIntent | null>(null);
  useEffect(
    () => registerClientUrlGroup(definition, mount, namePrefix, setIntent),
    [definition, mount, namePrefix],
  );

  // Optimistic destination (design: docs/design/client-urls-optimistic-destination.md).
  // `intent` is set urgently at navigation start so `pending` flips at once
  // for chrome; the CONTENT swap keys off the deferred value so it renders in
  // a transition lane: a destination that suspends with no boundary of its
  // own keeps the previous content visible (React's transition hold — the
  // pre-existing contract for routes without loading()), one with loading()
  // or inline <Suspense> at its reads presents immediately. Same-route intents
  // never swap: held data + transition() own that case.
  const pending = intent !== null;
  const presented = useDeferredValue(intent);
  const optimisticRoute =
    presented && presented.routeId !== routeId
      ? findRoute(definition, presented.routeId)
      : null;
  const route = optimisticRoute ?? findRoute(definition, routeId);

  // Pending entries for the destination's loaders: useLoader use()s a Promise
  // found in `loaderStreams` (the streaming-loader lane), so a read suspends
  // instead of throwing "not found in context". Nothing resolves them — the
  // canonical commit mounts the destination's own segment with real data and
  // unmounts this branch — so one shared promise serves every loader.
  // Memoized on the intent: use() needs a stable identity across replays.
  const optimistic = useMemo<{
    streams: Record<string, Promise<never>>;
    location: OptimisticLocation;
  } | null>(
    () =>
      optimisticRoute && presented
        ? {
            streams: Object.fromEntries(
              optimisticRoute.loaders.map((record) => [
                record.loader.$$id,
                PENDING_FOREVER,
              ]),
            ),
            location: {
              params: presented.params,
              pathname: presented.pathname,
              search: presented.search,
            },
          }
        : null,
    [optimisticRoute, presented],
  );

  // The wrapper chain below is IDENTICAL in the optimistic and the canonical
  // render (only prop values change): together with the group-keyed segment
  // (segment-system.tsx, ResolvedSegment.clientGroup) that is what lets the
  // destination instance survive the canonical commit.
  let content: ReactNode = createElement(route.component, { key: route.id });
  if (route.loading !== undefined) {
    // loading() is the route-level boundary for group routes (segment-system
    // places no LoaderBoundary around them); presence mirrors the
    // projection's hasLoading (loading("") is still a configured fallback).
    content = createElement(Suspense, {
      fallback: route.loading,
      children: content,
    });
  }

  for (let index = route.layouts.length - 1; index >= 0; index--) {
    const layoutKey = `${route.id}-layout-${index}`;
    content = createElement(OutletProvider, {
      key: layoutKey,
      content,
      pending,
      children: createElement(route.layouts[index], { key: layoutKey }),
    });
  }

  return createElement(OutletProvider, {
    content: null,
    loaderStreams: optimistic?.streams,
    pending,
    children: createElement(OptimisticLocationContext.Provider, {
      value: optimistic?.location ?? null,
      children: content,
    }),
  });
}

export function ClientUrlsLoading({
  definition,
  routeId,
}: {
  definition: ClientUrlPatterns;
  routeId: string;
}): ReactNode {
  return findRoute(definition, routeId).loading ?? null;
}
