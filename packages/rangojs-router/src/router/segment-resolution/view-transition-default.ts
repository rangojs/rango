/**
 * View-transition boundary default resolution.
 *
 * Kept in its own module (rather than helpers.ts) because several resolution
 * tests mock helpers.ts with an explicit export list; a shared util here is
 * never mocked, so the fresh and revalidation paths always get the real
 * implementation.
 */

import type { EntryData } from "../../server/context";

/**
 * Resolve the effective `viewTransition` for a segment's transition config.
 *
 * The per-segment value (set via the transition() DSL) always wins. When it is
 * unset, the router-level createRouter({ viewTransition }) default is stamped
 * in so the render gate reads the boundary decision off the segment — server
 * and client, via the serialized segment — without the router option being
 * threaded to the client. Only `false` is ever stamped; an unset (or "auto")
 * value is left untouched because it already means "wrap" at the gate, which
 * also avoids needless object allocation and payload growth. Used by both the
 * fresh and revalidation resolution paths.
 */
export function applyViewTransitionDefault(
  transition: EntryData["transition"],
  viewTransitionDefault: "auto" | false | undefined,
): EntryData["transition"] {
  if (!transition) return transition;
  if (
    transition.viewTransition === undefined &&
    viewTransitionDefault === false
  ) {
    return { ...transition, viewTransition: false };
  }
  return transition;
}
