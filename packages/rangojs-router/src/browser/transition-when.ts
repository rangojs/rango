/**
 * Browser-side transition({ when }) decisions.
 *
 * A navigation is decided ONCE, at the first commit that presents its
 * destination: the canonical commit for a server route, the optimistic swap
 * for a clientUrls() cross-route navigation (the canonical commit then reuses
 * the decision carried on its transaction), the history-cache restore or
 * refetch commit for back/forward, the action commit (error lane included).
 *
 * The decision is navigation-wide: every distinct predicate (by function
 * identity) declared by a committed segment, kept or re-sent (#989), runs, and
 * any false gates the whole navigation off. It never changes the rendered
 * tree's shape: every segment keeps its key and its <ViewTransition> element
 * (segment-system.tsx renders each class "none"), and the commit is urgent
 * instead of held (partial-update.ts). That is what keeps component state
 * across when true -> false -> true (#995). A response carries no decision,
 * so a reused prefetch is decided against the real source.
 */

import type {
  ResolvedSegment,
  RouteLocation,
  TransitionWhenContext,
  TransitionWhenFn,
  TransitionWhenKind,
} from "../types/segments.js";
import { resolveTransitionWhen } from "../transition-when-ref.js";
import { makeIsAction } from "../router/is-action.js";
import { isInterceptSegment } from "./intercept-utils.js";
import type { NavigationStore } from "./types.js";

/** One side of the navigation before it is frozen into a RouteLocation. */
export interface RouteLocationInput {
  url: string | URL;
  params?: Readonly<Record<string, string>>;
  routeName?: string;
  state?: unknown;
}

/** The action fields of a `kind: "action"` context. */
export interface TransitionWhenActionInput {
  id?: string;
  formData?: FormData;
  result?: unknown;
  error?: unknown;
}

export interface TransitionDecisionInput {
  kind: TransitionWhenKind;
  from: RouteLocationInput;
  /** The destination; ignored for "action" and "revalidate" (`to` is `from`). */
  to?: RouteLocationInput;
  action?: TransitionWhenActionInput;
}

const EMPTY_PARAMS: Readonly<Record<string, string>> = Object.freeze({});

function createRouteLocation(input: RouteLocationInput): RouteLocation {
  return Object.freeze({
    // A fresh URL: a predicate may not mutate the store's or the caller's.
    url: new URL(
      String(input.url),
      typeof window !== "undefined"
        ? window.location.href
        : "http://localhost/",
    ),
    params: input.params ? Object.freeze({ ...input.params }) : EMPTY_PARAMS,
    routeName: input.routeName,
    state: input.state,
  });
}

export function createTransitionWhenContext(
  input: TransitionDecisionInput,
): TransitionWhenContext {
  const from = createRouteLocation(input.from);
  const inAction = input.kind === "action";
  const { id, formData, result, error } = input.action ?? {};
  return Object.freeze({
    kind: input.kind,
    from,
    to:
      inAction || input.kind === "revalidate" || !input.to
        ? from
        : createRouteLocation(input.to),
    isAction: makeIsAction(id, inAction),
    ...(inAction && { action: Object.freeze({ id, formData, result, error }) }),
  });
}

/**
 * Run one predicate. A throw counts as false (the navigation does not hold)
 * and is logged; it never fails the navigation.
 */
export function evaluateTransitionWhen(
  fn: TransitionWhenFn,
  ctx: TransitionWhenContext,
): boolean {
  try {
    return fn(ctx) !== false;
  } catch (error) {
    console.error(
      "[rango] transition({ when }) threw; the navigation does not hold.",
      error,
    );
    return false;
  }
}

/** Distinct predicates of the segments that declare one, in segment order. */
export function collectTransitionWhens(
  segments: readonly ResolvedSegment[],
): Set<TransitionWhenFn> {
  const fns = new Set<TransitionWhenFn>();
  for (const segment of segments) {
    const fn = resolveTransitionWhen(segment.transition?.when);
    if (fn) fns.add(fn);
  }
  return fns;
}

/**
 * Decide a commit: true when the navigation is gated off (some predicate
 * returned false or threw). The context is built only when a predicate runs.
 * An intercept commit is not evaluated: it never holds or animates
 * (partial-update.ts shouldStartViewTransition). `extra` is a predicate not on
 * a segment yet (the optimistic clientUrls() destination).
 */
export function decideTransitionGatedOff(
  segments: readonly ResolvedSegment[],
  input: () => TransitionDecisionInput,
  extra?: TransitionWhenFn,
): boolean {
  if (segments.some(isInterceptSegment)) return false;
  const fns = collectTransitionWhens(segments);
  if (extra) fns.add(extra);
  if (fns.size === 0) return false;
  const ctx = createTransitionWhenContext(input());
  for (const fn of fns) if (!evaluateTransitionWhen(fn, ctx)) return true;
  return false;
}

/** Merge route params the way popstate restores them (per-segment params). */
export function mergeSegmentParams(
  segments: readonly ResolvedSegment[],
): Record<string, string> {
  const params: Record<string, string> = {};
  for (const s of segments) if (s.params) Object.assign(params, s.params);
  return params;
}

export interface CommitDecision {
  /** Newer params / route name for the committed location (an action response's). */
  from?: { params?: Record<string, string>; routeName?: string };
  /** The destination, from the committed location; omit for "action" / "revalidate". */
  to?: (from: RouteLocationInput) => RouteLocationInput;
  action?: TransitionWhenActionInput;
  extra?: TransitionWhenFn;
}

/**
 * decideTransitionGatedOff with `from` read from the store: call it before
 * the commit moves the store. `state` is the live history.state, except for
 * back/forward: at popstate history.state already belongs to the destination,
 * so the entry being left comes from the store's per-entry memory (undefined
 * after a reload, never guessed).
 */
export function decideCommitGatedOff(
  store: NavigationStore,
  segments: readonly ResolvedSegment[],
  kind: TransitionWhenKind,
  decision: CommitDecision = {},
): boolean {
  return decideTransitionGatedOff(
    segments,
    () => {
      const memory = store.getHistoryEntryMemory();
      const from: RouteLocationInput = {
        url: store.getSegmentState().currentUrl || window.location.href,
        params:
          decision.from?.params ??
          mergeSegmentParams(
            store.getCachedSegments(store.getHistoryKey())?.segments ?? [],
          ),
        routeName: decision.from?.routeName ?? memory?.routeName,
        state: kind === "pop" ? memory?.state : window.history.state,
      };
      return {
        kind,
        from,
        to: decision.to?.(from),
        action: decision.action,
      };
    },
    decision.extra,
  );
}

/** The FormData argument a server action was called with, if any. */
export function findActionFormData(
  args: readonly unknown[],
): FormData | undefined {
  if (typeof FormData === "undefined") return undefined;
  return args.find((arg): arg is FormData => arg instanceof FormData);
}
