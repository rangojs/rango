/**
 * View-transition boundary default resolution.
 *
 * Kept in its own module (rather than helpers.ts) because several resolution
 * tests mock helpers.ts with an explicit export list; a shared util here is
 * never mocked, so the fresh and revalidation paths always get the real
 * implementation.
 */

import type { EntryData } from "../../server/context";
import { getRequestContext } from "../../server/request-context.js";

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
 * `when`: a server-only predicate. It is STRIPPED from the returned config (a
 * function cannot cross Flight or the segment cache). PPR routes evaluate it
 * from the manifest before the pipeline; other routes record it here for the
 * existing post-handler gate. Used by both fresh and revalidation resolution.
 */
export function applyViewTransitionDefault(
  transition: EntryData["transition"],
  viewTransitionDefault: "auto" | false | undefined,
  segmentId?: string,
): EntryData["transition"] {
  if (!transition) return transition;
  let result = transition;
  if (result.when) {
    if (segmentId !== undefined) {
      try {
        const ctx = getRequestContext();
        if (!ctx._pprTransitionWhen?.has(segmentId)) {
          (ctx._transitionWhen ??= []).push({
            id: segmentId,
            when: result.when,
          });
        }
      } catch {
        // No active request context (e.g. a unit test calling this util
        // directly). Skip collection; the strip below still applies so the
        // serialized config never carries the function.
      }
    }
    const { when: _when, ...rest } = result;
    result = rest;
  }
  if (result.viewTransition === undefined && viewTransitionDefault === false) {
    return { ...result, viewTransition: false };
  }
  return result;
}
