"use client";

import { startTransition } from "react";
import { sameMountInstance } from "../router/substitute-pattern-params.js";
import type { ClientUrlPatterns } from "./types.js";
import type { TransitionWhenFn } from "../types/segments.js";

export interface ClientUrlNavigationIntent {
  readonly routeId: string;
  /**
   * The navigation began while an optimistic frame was on screen (a
   * superseded navigation's): ClientUrlsRoot presents it even when its route
   * is the committed one, so the committed params' data never comes back on
   * screen.
   */
  readonly fromFrame: boolean;
  /**
   * Destination params: the route's and its include() mount's, the params
   * useParams() reads after the commit.
   */
  readonly params: Readonly<Record<string, string>>;
  /** Absolute destination pathname (mount included) and search ("?..." or ""). */
  readonly pathname: string;
  readonly search: string;
  /** `history.state` the navigation will push (OptimisticLocation.state). */
  readonly state: unknown;
  /**
   * transition({ when }) gated this navigation off at the swap: the
   * destination presents urgently instead of in a transition lane.
   */
  readonly transitionGatedOff?: boolean;
}

/** What the bridge needs to decide transition({ when }) at the swap. */
export interface ClientUrlDestination {
  /** Destination params, the include() mount's included. */
  readonly params: Readonly<Record<string, string>>;
  /** Canonical route name (include prefix applied); undefined when unnamed. */
  readonly routeName: string | undefined;
  /** The destination route's own `when`, from its "use client" definition. */
  readonly when: TransitionWhenFn | undefined;
  /** `history.state` the navigation will push (ClientUrlNavigationIntent.state). */
  readonly state: unknown;
}

interface ActiveClientUrlGroup {
  readonly definition: ClientUrlPatterns;
  /**
   * include() mount the group is rendered under ("/" at root): the PATTERN
   * (`/:locale?`), as useMount() returns it.
   */
  readonly mount: string;
  /** include() route-name prefix ("" at root) for canonical name composition. */
  readonly namePrefix: string;
  /** The server's routes that compete with the group's (ClientUrlsRoot). */
  readonly foreign: readonly string[] | undefined;
  /**
   * The group route on screen (ClientUrlsRoot's committed routeId), undefined
   * while an optimistic frame is. Registered at commit.
   */
  readonly routeId: string | undefined;
  readonly setIntent: (intent: ClientUrlNavigationIntent | null) => void;
  intent?: ClientUrlNavigationIntent | null;
}

/**
 * Intercept TARGET route names reachable from the CURRENT location as a
 * navigation origin, shipped in payload metadata (MatchResult.interceptTargets)
 * and refreshed on every commit. When a local match's canonical route name is
 * in this set, the optimistic presentation DECLINES: the canonical response
 * will commit the intercept over the ORIGIN page, so destination loading would
 * flash and revert. Conservative for `when`-conditional intercepts (their
 * selectors need live navigation context): a non-intercepted navigation may
 * lose its optimistic loading, never the reverse.
 */
let activeInterceptTargets: ReadonlySet<string> = new Set();

export function setActiveInterceptTargets(
  targets: readonly string[] | undefined,
): void {
  activeInterceptTargets = new Set(targets ?? []);
}

export interface ClientUrlNavigationPresentation {
  readonly routeId: string;
  /**
   * The transition({ when }) decision made at the optimistic swap (true =
   * gated off), or undefined when nothing was swapped (a same-route
   * navigation decides at the canonical commit).
   */
  readonly transitionGatedOff?: boolean;
  clear(): void;
}

let activeGroup: ActiveClientUrlGroup | null = null;

export function registerClientUrlGroup(
  definition: ClientUrlPatterns,
  mount: string,
  namePrefix: string,
  setIntent: (intent: ClientUrlNavigationIntent | null) => void,
  routeId?: string,
  foreign?: readonly string[],
): () => void {
  const group: ActiveClientUrlGroup = {
    definition,
    mount,
    namePrefix,
    foreign,
    routeId,
    setIntent,
  };
  activeGroup = group;

  return () => {
    if (activeGroup === group) activeGroup = null;
  };
}

export function beginClientUrlNavigation(
  targetUrl: URL,
  signal: AbortSignal,
  /** Builds the entry state; called only when the group presents the target. */
  buildState?: () => unknown,
  decideTransition?: (destination: ClientUrlDestination) => boolean,
): ClientUrlNavigationPresentation | null {
  const group = activeGroup;
  if (!group) return null;

  // Not one of the group's routes under its mount pattern, or a server route
  // that wins the URL (a foreign leaf): no optimistic presentation.
  const match = group.definition.match(
    targetUrl.pathname,
    group.mount,
    group.foreign,
  );
  if (!match || match.redirectTo) return null;
  const record = group.definition.routes.find(
    (candidate) => candidate.id === match.routeKey,
  );
  if (!record) return null;
  // Other mount params (`/en/...` to `/de/...`) are another instance of the
  // group: a frame would render the destination inside the old instance's
  // chrome (the server's layouts above the group, still the old locale's).
  // Such a click leaves the group: a plain navigation. History still holds the
  // committed entry while a frame is on screen, so it is the origin.
  if (group.mount.includes(":")) {
    const origin = group.definition.match(
      window.location.pathname,
      group.mount,
      group.foreign,
    );
    if (
      !origin ||
      !sameMountInstance(group.mount, origin.params, match.params)
    ) {
      return null;
    }
  }

  // Decline when an intercept would claim this target: compose the matched
  // record's canonical route name (include namePrefix + local name) and check
  // it against the current location's intercept target set. Unnamed records
  // cannot be intercept targets (intercepts target route NAMES).
  const canonicalName = record.name
    ? group.namePrefix
      ? `${group.namePrefix}.${record.name}`
      : record.name
    : undefined;
  if (canonicalName && activeInterceptTargets.has(canonicalName)) return null;

  const state = buildState?.();

  // A same-route intent from the committed page never swaps (ClientUrlsRoot),
  // so transition({ when }) decides at the canonical commit; one that swaps
  // decides here, at the navigation's first presentation. While a frame is on
  // screen, group.routeId is undefined and every intent swaps.
  let transitionGatedOff: boolean | undefined;
  if (decideTransition && match.routeKey !== group.routeId) {
    const when = record.transition?.when;
    transitionGatedOff = decideTransition({
      params: match.params,
      routeName: canonicalName,
      when: typeof when === "function" ? when : undefined,
      state,
    });
  }

  const intent: ClientUrlNavigationIntent = {
    routeId: match.routeKey,
    // From what React committed, not group.intent: a superseded intent is
    // cleared when its canonical commit is handed over, before React renders
    // it, and its frame is still on screen until then.
    fromFrame: !group.routeId,
    params: match.params,
    pathname: targetUrl.pathname,
    search: targetUrl.search,
    state,
    transitionGatedOff,
  };
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
  // An abort after clear() finds another intent or none and does nothing.
  signal.addEventListener("abort", clear);

  return { ...intent, clear };
}

export function clearClientUrlNavigationRegistry(): void {
  activeGroup = null;
  activeInterceptTargets = new Set();
}
