"use client";

import { startTransition } from "react";
import { makeIsAction } from "../router/is-action.js";
import {
  lockedClientDefault,
  runClientRevalidateChain,
} from "./revalidate-chain.js";
import { encodeClientRevalidationDecisions } from "./revalidation-protocol.js";
import type { ClientUrlPatterns } from "./types.js";

export interface ClientUrlNavigationIntent {
  readonly routeId: string;
}

interface ActiveClientUrlGroup {
  readonly definition: ClientUrlPatterns;
  /** include() mount prefix the group is rendered under ("/" at root). */
  readonly mount: string;
  /** include() route-name prefix ("" at root) for canonical name composition. */
  readonly namePrefix: string;
  readonly setIntent: (intent: ClientUrlNavigationIntent | null) => void;
  intent: ClientUrlNavigationIntent | null;
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
  clear(): void;
}

let activeGroup: ActiveClientUrlGroup | null = null;

/**
 * Strip the include mount prefix from an absolute pathname, yielding the
 * definition-local pathname the module trie was built from. Returns null when
 * the pathname lies outside the mount — the navigation then targets a server
 * route and gets no optimistic presentation. Mirrors joinMount() in
 * use-reverse.ts: the bare mount maps to the module index "/".
 */
function stripMountPrefix(pathname: string, mount: string): string | null {
  if (mount === "" || mount === "/") return pathname;
  const normalized = mount.endsWith("/") ? mount.slice(0, -1) : mount;
  if (pathname === normalized) return "/";
  if (pathname.startsWith(`${normalized}/`)) {
    return pathname.slice(normalized.length);
  }
  return null;
}

export function registerClientUrlGroup(
  definition: ClientUrlPatterns,
  mount: string,
  namePrefix: string,
  setIntent: (intent: ClientUrlNavigationIntent | null) => void,
): () => void {
  const group: ActiveClientUrlGroup = {
    definition,
    mount,
    namePrefix,
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

  const localPathname = stripMountPrefix(targetUrl.pathname, group.mount);
  if (localPathname === null) return null;

  const match = group.definition.match(localPathname);
  if (!match || match.redirectTo) return null;

  // Decline when an intercept would claim this target: compose the matched
  // record's canonical route name (include namePrefix + local name) and check
  // it against the current location's intercept target set. Unnamed records
  // cannot be intercept targets (intercepts target route NAMES).
  const record = group.definition.routes.find(
    (candidate) => candidate.id === match.routeKey,
  );
  if (record?.name) {
    const canonicalName = group.namePrefix
      ? `${group.namePrefix}.${record.name}`
      : record.name;
    if (activeInterceptTargets.has(canonicalName)) return null;
  }

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

/**
 * Run the held clientUrls route's per-loader revalidate() predicates and
 * encode their decisions for the request header. Predicates are CLIENT code
 * (declared in the "use client" definition module); only decisions cross the
 * wire — the synthesized per-loader revalidate() on every materialized stub
 * (server-projection.ts) reads them back by loader $$id.
 *
 * Decisions exist only for the loaders the client currently HOLDS: the local
 * match of currentUrl. They matter when the server would re-evaluate those
 * held loader segments — same-route param/search navs, actions, and stale
 * restores. Cross-route targets render new segments unconditionally, so a
 * decision would be ignored; we still compute against the current route since
 * only its held segments are addressable.
 *
 * Returns null when no group is active, the current location is not a client
 * route, or no predicate produced a decision that differs from the locked
 * default — the server then applies defaults, which is also the behavior for
 * requests that cannot carry decisions (no-JS, PE, prefetch, document loads).
 */
export function collectClientRevalidationDecisions(options: {
  currentUrl: URL;
  nextUrl: URL;
  /**
   * True only when the decisions ride the action POST itself — the one
   * request the server evaluates with actionContext (locked default true).
   * Action-triggered refetch GETs (partial-update terminals) pass false:
   * the server gives those navigation defaults, and the delta gate below
   * must diff against the default the SERVER will use, or a force decision
   * on the refetch would be silently swallowed as "equals default".
   */
  actionRequest: boolean;
  /** Action TRUTH for the predicates' isAction() matcher; may be true on
   * refetch GETs where actionRequest is false. */
  isAction: boolean;
  actionId?: string;
  stale: boolean;
}): string | null {
  const group = activeGroup;
  if (!group) return null;

  const { currentUrl, nextUrl, actionRequest, isAction, actionId, stale } =
    options;
  const currentLocal = stripMountPrefix(currentUrl.pathname, group.mount);
  if (currentLocal === null) return null;
  const currentMatch = group.definition.match(currentLocal);
  if (!currentMatch || currentMatch.redirectTo) return null;
  const record = group.definition.routes.find(
    (candidate) => candidate.id === currentMatch.routeKey,
  );
  if (!record) return null;

  const nextLocal = stripMountPrefix(nextUrl.pathname, group.mount);
  const nextMatch =
    nextLocal === null ? null : group.definition.match(nextLocal);
  const nextParams = nextMatch?.params ?? {};

  const defaultShouldRevalidate = lockedClientDefault({
    actionRequest,
    currentParams: currentMatch.params,
    nextParams,
    currentUrl,
    nextUrl,
  });

  const baseArgs = {
    currentUrl,
    nextUrl,
    currentParams: currentMatch.params,
    nextParams,
    stale,
    isAction: makeIsAction(actionId, isAction),
    ...(actionId !== undefined ? { actionId } : {}),
  };
  const skip: string[] = [];
  const force: string[] = [];
  for (const { loader, revalidate } of record.loaders) {
    if (revalidate.length === 0) continue;
    const decision = runClientRevalidateChain(
      revalidate,
      baseArgs,
      defaultShouldRevalidate,
      `loader "${loader.$$id}"`,
    );
    if (decision === defaultShouldRevalidate) continue;
    (decision ? force : skip).push(loader.$$id);
  }

  return encodeClientRevalidationDecisions({ skip, force });
}

export function clearClientUrlNavigationRegistry(): void {
  activeGroup = null;
  activeInterceptTargets = new Set();
}
