"use client";

import {
  createElement,
  Fragment,
  useEffect,
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
import type {
  ClientUrlInterceptRecord,
  ClientUrlPatterns,
  ClientUrlRouteRecord,
} from "./types.js";

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

  const pendingRoute =
    intent && intent.routeId !== routeId
      ? findRoute(definition, intent.routeId)
      : null;
  // Presence must mirror the projection's hasLoading (`loading !== undefined`
  // in server-projection.ts): a falsy-but-valid node like loading("") is still
  // a configured destination loading state, not an absent one.
  const hasPendingLoading =
    pendingRoute !== null && pendingRoute.loading !== undefined;
  const route = hasPendingLoading
    ? pendingRoute
    : findRoute(definition, routeId);
  // ANY in-flight group navigation is pending — including same-route navs
  // (intent.routeId === routeId). For the search-only shape (filters, tabs)
  // the canonical commit is HELD in a transition (isSameStructureNav in
  // partial-update.ts) with no content swap to signal progress — this flag
  // is the only affordance. The urgent setIntent at nav start flips it
  // immediately; the transition-wrapped clear() entangles with the held
  // commit, so pending drops exactly when the data lands.
  const pending = intent !== null;
  let content: ReactNode = hasPendingLoading
    ? pendingRoute.loading
    : createElement(route.component, { key: route.id });

  for (let index = route.layouts.length - 1; index >= 0; index--) {
    const layoutKey = `${route.id}-layout-${index}`;
    content = createElement(OutletProvider, {
      key: layoutKey,
      content,
      pending,
      children: createElement(route.layouts[index], { key: layoutKey }),
    });
  }

  return content;
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
