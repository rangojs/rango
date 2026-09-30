/**
 * runTransitionWhen — unit-test a transition({ when }) browser predicate.
 *
 * Builds the context and evaluates the predicate through the SAME browser
 * functions the router uses at navigation time (browser/transition-when.ts):
 * a throw counts as false and is logged. Accepts the predicate or a whole
 * TransitionConfig.
 */

import {
  createTransitionWhenContext,
  evaluateTransitionWhen,
} from "../browser/transition-when.js";
import type {
  TransitionConfig,
  TransitionWhenContext,
  TransitionWhenFn,
  TransitionWhenKind,
} from "../types/segments.js";

export interface RunTransitionWhenOptions {
  /** Defaults to `"push"`. */
  kind?: TransitionWhenKind;
  /** The committed location being left. Defaults to `http://localhost/`. */
  from?: string | URL;
  /** The destination. Defaults to `from`. */
  to?: string | URL;
}

export interface RunTransitionWhenResult {
  /** True when the navigation holds (the predicate did not return false or throw, or there is none). */
  applied: boolean;
  /** Inverse of `applied`. */
  gatedOff: boolean;
  /** The context the predicate received. */
  context: TransitionWhenContext;
}

export function runTransitionWhen(
  whenOrConfig: TransitionWhenFn | TransitionConfig,
  opts: RunTransitionWhenOptions = {},
): RunTransitionWhenResult {
  const from = opts.from ?? "http://localhost/";
  const context = createTransitionWhenContext({
    kind: opts.kind ?? "push",
    from: { url: from },
    to: { url: opts.to ?? from },
  });
  const when =
    typeof whenOrConfig === "function" ? whenOrConfig : whenOrConfig.when;
  const applied = when ? evaluateTransitionWhen(when, context) : true;
  return { applied, gatedOff: !applied, context };
}
