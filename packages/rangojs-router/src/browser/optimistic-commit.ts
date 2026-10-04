import type { ViewTransitionClass } from "../types/segments.js";

/**
 * Transition type added to the canonical commit of a navigation that already
 * presented an optimistic clientUrls() destination (client-urls/client-root.tsx).
 * The optimistic swap ran in a transition lane and got the route's configured
 * <ViewTransition> animation; the commit then replaces the branch with the
 * destination's own segment — identical pixels — so every router-placed
 * boundary maps this type to "none" (withOptimisticCommitNone) and the user
 * perceives one animated navigation, not two.
 */
export const OPTIMISTIC_COMMIT_TRANSITION_TYPE = "rango-optimistic-commit";

/**
 * Merge the "none" mapping for the optimistic-commit type into a
 * <ViewTransition> class prop. A string class becomes the `default` entry of
 * a map; an absent prop yields the shared type-only map (React falls back to
 * the boundary's `default` prop for other types).
 */
const NONE_ONLY: ViewTransitionClass = Object.freeze({
  [OPTIMISTIC_COMMIT_TRANSITION_TYPE]: "none",
});

export function withOptimisticCommitNone(
  value: ViewTransitionClass | undefined,
): ViewTransitionClass {
  if (value === undefined) return NONE_ONLY;
  if (typeof value === "string") {
    return { default: value, [OPTIMISTIC_COMMIT_TRANSITION_TYPE]: "none" };
  }
  return { ...value, [OPTIMISTIC_COMMIT_TRANSITION_TYPE]: "none" };
}
