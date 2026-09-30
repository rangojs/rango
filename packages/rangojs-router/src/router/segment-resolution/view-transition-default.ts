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
 * Resolve a segment's transition config: stamp the `viewTransition` default and
 * peel off a transition({ when }) predicate.
 *
 * `viewTransition`: the per-segment value (set via the transition() DSL) always
 * wins. When it is unset, the router-level createRouter({ viewTransition })
 * default is stamped in so the render gate reads the boundary decision off the
 * segment — server and client, via the serialized segment — without the router
 * option being threaded to the client. Only `false` is ever stamped; an unset
 * (or "auto") value is left untouched because it already means "wrap" at the
 * gate, which also avoids needless object allocation and payload growth.
 *
 * `when`: a client reference the server never calls. It is STRIPPED here so no
 * segment record (segment cache, prerender artifact, shell snapshot) carries
 * it: those stores JSON-serialize the config and would silently drop it on
 * some stores and keep it on others. rsc/attach-transition-when.ts attaches it
 * from the route definition right before Flight instead. Used by both fresh
 * and revalidation resolution.
 */
export function applyViewTransitionDefault(
  transition: EntryData["transition"],
  viewTransitionDefault: "auto" | false | undefined,
): EntryData["transition"] {
  if (!transition) return transition;
  let result = transition;
  if (result.when) {
    const { when: _when, ...rest } = result;
    result = rest;
  }
  if (result.viewTransition === undefined && viewTransitionDefault === false) {
    return { ...result, viewTransition: false };
  }
  return result;
}
