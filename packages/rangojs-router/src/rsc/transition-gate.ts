import type { MatchResult } from "../types.js";
import type { getRequestContext } from "../server/request-context.js";
import { invokeOnError } from "../router/error-handling.js";
import type { OnErrorCallback } from "../types/error-types.js";

/**
 * Apply transition({ when }) gates to a payload's segments.
 *
 * The predicates were collected during resolution (keyed by segment id) and
 * stripped from the serialized config; here — after handlers ran and outside any
 * cache scope — we evaluate each and drop the segment's transition when the
 * predicate does not hold, so the navigation streams its loading fallback
 * instead of holding the previous content. A predicate that throws is reported
 * to the router's onError (phase "rendering") and then treated as "do not hold"
 * (conservative), so a buggy predicate degrades to no transition rather than
 * failing the response.
 *
 * Mutating the segments here is safe: the segment cache stores a serialized copy
 * (segment-codec), written during match() BEFORE this gate runs, so dropping a
 * transition never corrupts a cache entry. The flip side is that a cache hit
 * skips resolution, collects no predicate, and replays the cached transition
 * as-is (it was serialized before the gate) — combining transition({ when })
 * with cache() on the same segment freezes the gate to its cached state, so
 * avoid caching a route whose transition decision is request-dependent.
 *
 * Returns the same array (mutated) for inline use at the payload's `segments`
 * field.
 */
export function gateTransitions(
  segments: MatchResult["segments"],
  ctx: ReturnType<typeof getRequestContext>,
  onError?: OnErrorCallback,
): MatchResult["segments"] {
  const predicates = ctx._transitionWhen;
  if (predicates && predicates.length) {
    for (const { id, when } of predicates) {
      let drop: boolean;
      try {
        // The predicate's TransitionWhenContext is a read-only subset of this
        // RequestContext (get/params/request/url/method/env), so the request
        // context passes directly — no cast, and consumers can only type-read
        // fields that actually exist here.
        drop = when(ctx) === false;
      } catch (error) {
        // A throwing predicate must not fail the response: report it and treat
        // the transition as gated off (do not hold). invokeOnError no-ops when
        // onError is undefined.
        drop = true;
        invokeOnError(
          onError,
          error,
          "rendering",
          {
            request: ctx.request,
            url: ctx.url,
            params: ctx.params,
            segmentId: id,
          },
          "RSC",
        );
      }
      if (drop) {
        const seg = segments.find((s) => s.id === id);
        if (seg) seg.transition = undefined;
      }
    }
  }
  return segments;
}
