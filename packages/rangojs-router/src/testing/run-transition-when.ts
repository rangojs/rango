/**
 * runTransitionWhen — unit-test a transition({ when }) browser predicate.
 *
 * Builds the context and evaluates the predicate through the SAME browser
 * functions the router uses at navigation time (browser/transition-when.ts):
 * a throw counts as false and is logged. `from`/`to` take a URL string or a
 * partial RouteLocation; a `state` given as location-state entries
 * (`[Def(value)]`, what Link/push take) is stored the way a push stores it,
 * so `Def.read(ctx.to)` reads it back. Accepts the predicate or a whole
 * TransitionConfig.
 *
 * Synchronous: a transition predicate returns a boolean and has no I/O.
 */

import {
  createTransitionWhenContext,
  evaluateTransitionWhen,
  type RouteLocationInput,
} from "../browser/transition-when.js";
import {
  buildHistoryState,
  resolveNavigationState,
} from "../browser/history-state.js";
import { isLocationStateEntry } from "../browser/react/location-state-shared.js";
import { resolveTestActionId } from "./internal/action-id.js";
import type {
  RouteLocation,
  TransitionConfig,
  TransitionWhenContext,
  TransitionWhenFn,
  TransitionWhenKind,
} from "../types/segments.js";

type ImportedAction = (...args: never[]) => unknown;

/** A navigation side: a URL, or a partial RouteLocation. */
export type RunTransitionWhenLocation =
  | string
  | URL
  | (Partial<Omit<RouteLocation, "url">> & { url?: string | URL });

/** The action fields of a `kind: "action"` context. */
export interface RunTransitionWhenAction {
  /** The triggering action: an imported server action or its actionId. */
  ref?: ImportedAction | string;
  formData?: FormData;
  /** The action's return value on success. */
  result?: unknown;
  /** What a failed action threw (the error lane). */
  error?: unknown;
}

export interface RunTransitionWhenOptions {
  /** Defaults to `"action"` when `action` is given, `"push"` otherwise. */
  kind?: TransitionWhenKind;
  /** The committed location being left. Defaults to `http://localhost/`. */
  from?: RunTransitionWhenLocation;
  /** The destination. Defaults to `from`; always `from` for "action" and "revalidate". */
  to?: RunTransitionWhenLocation;
  /**
   * The triggering action (like runClientRevalidate's): an imported server
   * action (id via `$id ?? $$id`), an actionId string, or
   * `{ ref, formData, result, error }`.
   */
  action?: ImportedAction | string | RunTransitionWhenAction;
}

export interface RunTransitionWhenResult {
  /** True when the navigation holds (the predicate did not return false or throw, or there is none). */
  applied: boolean;
  /** Inverse of `applied`. */
  gatedOff: boolean;
  /** The context the predicate received. */
  context: TransitionWhenContext;
}

const DEFAULT_URL = "http://localhost/";

function toStoredState(state: unknown): unknown {
  if (
    Array.isArray(state) &&
    state.length > 0 &&
    isLocationStateEntry(state[0])
  ) {
    return buildHistoryState(resolveNavigationState(state));
  }
  return state;
}

function toLocation(
  value: RunTransitionWhenLocation | undefined,
  fallback: string | URL,
): RouteLocationInput {
  if (value === undefined) return { url: fallback };
  if (typeof value === "string" || value instanceof URL) return { url: value };
  return {
    url: value.url ?? fallback,
    params: value.params,
    routeName: value.routeName,
    state: toStoredState(value.state),
  };
}

export function runTransitionWhen(
  whenOrConfig: TransitionWhenFn | TransitionConfig,
  opts: RunTransitionWhenOptions = {},
): RunTransitionWhenResult {
  const actionOption =
    typeof opts.action === "function" || typeof opts.action === "string"
      ? { ref: opts.action }
      : opts.action;
  const from = toLocation(opts.from, DEFAULT_URL);
  const context = createTransitionWhenContext({
    kind: opts.kind ?? (actionOption ? "action" : "push"),
    from,
    to: opts.to === undefined ? undefined : toLocation(opts.to, from.url),
    ...(actionOption
      ? {
          action: {
            id: resolveTestActionId(actionOption.ref, "runTransitionWhen"),
            formData: actionOption.formData,
            result: actionOption.result,
            error: actionOption.error,
          },
        }
      : {}),
  });
  const when =
    typeof whenOrConfig === "function" ? whenOrConfig : whenOrConfig.when;
  const applied = when ? evaluateTransitionWhen(when, context) : true;
  return { applied, gatedOff: !applied, context };
}
