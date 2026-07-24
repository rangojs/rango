"use client";

import { createElement, useEffect, useState, type ReactNode } from "react";
import { OutletProvider } from "../outlet-provider.js";
import {
  registerClientUrlGroup,
  type ClientUrlNavigationIntent,
} from "./navigation.js";
import type { ClientUrlPatterns, ClientUrlRouteRecord } from "./types.js";

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

export function ClientUrlsRoot({
  definition,
  routeId,
}: {
  definition: ClientUrlPatterns;
  routeId: string;
}): ReactNode {
  const [intent, setIntent] = useState<ClientUrlNavigationIntent | null>(null);
  useEffect(() => registerClientUrlGroup(definition, setIntent), [definition]);

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
  const pending = pendingRoute !== null;
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
