"use client";

import {
  createElement,
  Fragment,
  Suspense,
  useDeferredValue,
  useLayoutEffect,
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
import { OptimisticLocationContext } from "./optimistic-location.js";
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
  foreign,
}: {
  definition: ClientUrlPatterns;
  routeId: string;
  /** include() route-name prefix, injected at materialization for canonical
   *  name composition (intercept-target coordination). */
  namePrefix?: string;
  /** The server's routes that compete with the group's for a URL
   *  (competingPatterns in server-projection.ts). */
  foreign?: readonly string[];
}): ReactNode {
  // The include() mount pattern this group renders under ("/" at root).
  // Navigation matches an absolute pathname against the definition's
  // patterns joined to it (buildClientUrlsTrie in client-urls.ts), as
  // useReverse joins it.
  const mount = useMount();
  const [intent, setIntent] = useState<ClientUrlNavigationIntent | null>(null);

  // Optimistic destination (design: docs/design/client-urls-optimistic-destination.md).
  // `intent` is set urgently at navigation start so `pending` flips at once
  // for chrome; the CONTENT swap keys off the deferred value so it renders in
  // a transition lane: a destination that suspends with no boundary of its
  // own keeps the previous content visible (React's transition hold — the
  // pre-existing contract for routes without loading()), one with loading()
  // or inline <Suspense> at its reads presents immediately. Same-route intents
  // from the committed page never swap: held data + transition() own that
  // case; one that began on an optimistic frame does (fromFrame). A
  // navigation its transition({ when }) gated off at the swap presents
  // urgently: no hold, no view transition, the destination's loading()
  // streams.
  const pending = intent !== null;
  const deferred = useDeferredValue(intent);
  const presented = intent?.transitionGatedOff ? intent : deferred;
  const optimisticRoute =
    presented && (presented.routeId !== routeId || presented.fromFrame)
      ? findRoute(definition, presented.routeId)
      : null;
  const route = optimisticRoute ?? findRoute(definition, routeId);

  // At commit, so a navigation reads what is on screen (no routeId while a
  // frame is): React renders transition lanes one at a time, so the render
  // that presents the next intent may still lack the canonical commit of the
  // one it supersedes.
  useLayoutEffect(
    () =>
      registerClientUrlGroup(
        definition,
        mount,
        namePrefix,
        setIntent,
        optimisticRoute ? undefined : routeId,
        foreign,
      ),
    [definition, mount, namePrefix, routeId, optimisticRoute, foreign],
  );

  // Pending entries for the destination's loaders: useLoader use()s a Promise
  // found in `loaderStreams`, so a read suspends instead of throwing "not
  // found in context"; the canonical commit brings the real data. Skips the
  // committed route's layout() records: flattenLayout creates them once per
  // layout, so one the destination holds too is a layout both keep mounted
  // (#1124), reading committed data. Route-own loaders always wait, also on
  // a return to the committed route (fromFrame).
  const loaderStreams = useMemo(
    () =>
      optimisticRoute
        ? Object.fromEntries(
            optimisticRoute.loaders
              .filter(
                (record) =>
                  !findRoute(definition, routeId).layoutLoaders.includes(
                    record,
                  ),
              )
              .map((record) => [record.loader.$$id, PENDING_FOREVER]),
          )
        : undefined,
    [optimisticRoute, definition, routeId],
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

  // Keyed per layout() item, not per route (#1124).
  for (let index = route.layouts.length - 1; index >= 0; index--) {
    content = createElement(OutletProvider, {
      key: route.layoutKeys[index],
      content,
      pending,
      children: createElement(route.layouts[index]),
    });
  }

  return createElement(OutletProvider, {
    content: null,
    loaderStreams,
    pending,
    children: createElement(OptimisticLocationContext.Provider, {
      // The intent carries every OptimisticLocation field.
      value: optimisticRoute ? presented : null,
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
