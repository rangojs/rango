import type { MatchResult } from "../types.js";
import type { getRequestContext } from "../server/request-context.js";
import {
  createTransitionWhenError,
  isTransitionWhenValidationEnabled,
  transitionWhenProblem,
} from "../transition-when-ref.js";

/**
 * Attach transition({ when }) references to a payload's segments, right before
 * Flight. Returns a copy for every segment it changes: the input segments may
 * be the records a cache, prerender, or shell snapshot holds.
 *
 * Only a segment that carries `transition` gets its predicate. The config
 * itself never varies per request, so the segment key and the <ViewTransition>
 * wrapper depend only on the route definition (#995); the browser decides for
 * every committed segment, kept ones included (#989).
 *
 * Render-time backstop for an invalid `when` that route discovery did not see
 * (a route evaluated lazily at runtime): it throws the discovery error. A
 * plain function reaching Flight would otherwise fail with React's generic
 * "Functions cannot be passed directly to Client Components", or be dropped.
 */
export function attachTransitionWhen(
  segments: MatchResult["segments"],
  ctx: ReturnType<typeof getRequestContext>,
): MatchResult["segments"] {
  const refs = ctx?._transitionWhenRefs;
  if (!refs) return segments;
  const strict = isTransitionWhenValidationEnabled();
  let out = segments;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const record = segment.transition ? refs.get(segment.id) : undefined;
    if (!record || segment.transition!.when === record.when) continue;
    const problem = transitionWhenProblem(record.when, strict);
    if (problem) {
      throw createTransitionWhenError(record.when, problem, record.site);
    }
    if (out === segments) out = [...segments];
    out[i] = {
      ...segment,
      transition: { ...segment.transition, when: record.when },
    };
  }
  return out;
}
