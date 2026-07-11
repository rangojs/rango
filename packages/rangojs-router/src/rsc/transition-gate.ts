import type { MatchResult } from "../types.js";
import type { getRequestContext } from "../server/request-context.js";
import { invokeOnError } from "../router/error-handling.js";
import type { OnErrorCallback } from "../types/error-types.js";
import { createTransitionWhenContext } from "../router/transition-when.js";

/**
 * Apply transition({ when }) gates to a payload's segments.
 *
 * PPR predicates were evaluated from the manifest before cache lookup and route
 * handlers; their request-specific decisions are projected onto a copy so they
 * never mutate reusable cache/prerender/shell records. Ordinary-route predicates
 * were collected during fresh resolution and are evaluated here after handlers.
 * Both paths drop the segment transition when the predicate does not hold.
 *
 * Mutating the segments here is safe: the segment cache stores a serialized copy
 * (segment-codec), written during match() BEFORE this gate runs, so dropping a
 * transition never corrupts a cache entry. On an ordinary route, a cache hit
 * skips resolution, collects no predicate, and replays the cached transition
 * as-is (it was serialized before the gate). PPR routes are the exception: their
 * manifest predicates were evaluated before lookup and apply to replayed data.
 *
 * Returns the same array for the ordinary post-handler path. A PPR drop returns a
 * copy containing only the request-specific transition changes.
 */
export function gateTransitions(
  segments: MatchResult["segments"],
  ctx: ReturnType<typeof getRequestContext>,
  onError?: OnErrorCallback,
): MatchResult["segments"] {
  const pprDecisions = ctx._pprTransitionDecisions;
  let gatedSegments = segments;

  const dropTransition = (id: string): void => {
    const index = gatedSegments.findIndex((segment) => segment.id === id);
    if (index === -1) return;
    if (!pprDecisions) {
      gatedSegments[index].transition = undefined;
      return;
    }
    if (gatedSegments === segments) gatedSegments = [...segments];
    gatedSegments[index] = {
      ...gatedSegments[index],
      transition: undefined,
    };
  };

  if (pprDecisions) {
    for (const [id, keep] of pprDecisions) {
      if (!keep) dropTransition(id);
    }
  }
  const predicates = ctx._transitionWhen;
  if (predicates) {
    for (const { id, when } of predicates) {
      try {
        // Assemble the ShouldRevalidateFn-shaped predicate context from the
        // request context. Source fields (currentUrl/currentParams/fromRouteName)
        // were stashed at match time from the navigation snapshot; action fields
        // at the action-bearing gate call sites. nextUrl/nextParams/toRouteName/
        // method/get/env come straight off ctx (setRequestContextParams ran
        // before the gate). Source/action fields are undefined when absent —
        // never fabricated (see TransitionWhenContext).
        if (when(createTransitionWhenContext(ctx)) !== false) continue;
      } catch (error) {
        // A throwing predicate must not fail the response: report it and treat
        // the transition as gated off (do not hold). invokeOnError no-ops when
        // onError is undefined.
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
      dropTransition(id);
    }
  }
  return gatedSegments;
}
