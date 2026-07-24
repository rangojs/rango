"use client";

import { startTransition } from "react";
import type { ClientUrlPatterns } from "./types.js";

export interface ClientUrlNavigationIntent {
  readonly routeId: string;
}

interface ActiveClientUrlGroup {
  readonly definition: ClientUrlPatterns;
  readonly setIntent: (intent: ClientUrlNavigationIntent | null) => void;
  intent: ClientUrlNavigationIntent | null;
}

export interface ClientUrlNavigationPresentation {
  readonly routeId: string;
  clear(): void;
}

let activeGroup: ActiveClientUrlGroup | null = null;

export function registerClientUrlGroup(
  definition: ClientUrlPatterns,
  setIntent: (intent: ClientUrlNavigationIntent | null) => void,
): () => void {
  const group: ActiveClientUrlGroup = {
    definition,
    setIntent,
    intent: null,
  };
  activeGroup = group;

  return () => {
    if (activeGroup === group) activeGroup = null;
  };
}

export function beginClientUrlNavigation(
  targetUrl: URL,
  signal: AbortSignal,
): ClientUrlNavigationPresentation | null {
  const group = activeGroup;
  if (!group) return null;

  const match = group.definition.match(targetUrl.pathname);
  if (!match || match.redirectTo) return null;

  const intent: ClientUrlNavigationIntent = { routeId: match.routeKey };
  group.intent = intent;
  group.setIntent(intent);

  const clear = (): void => {
    if (group.intent !== intent) return;
    group.intent = null;
    // The canonical commit may be held in a startTransition (explicit
    // transition() routes, view transitions, action revalidations in
    // partial-update.ts). An urgent clear would flush against the
    // pre-transition tree first — loading UI → ORIGIN content → destination.
    // Clearing inside a transition keeps the optimistic presentation until
    // the destination commit lands; on the plain urgent commit path both
    // updates land in order, so this changes nothing there.
    startTransition(() => group.setIntent(null));
  };
  signal.addEventListener("abort", clear, { once: true });

  return {
    routeId: match.routeKey,
    clear() {
      signal.removeEventListener("abort", clear);
      clear();
    },
  };
}

export function clearClientUrlNavigationRegistry(): void {
  activeGroup = null;
}
