import type { ResolvedSegment } from "./types.js";
import type { SlotState } from "../types.js";
import { isPlaceholder } from "../types/segments.js";
import { loaderParentId } from "./react/filter-segment-order.js";

/**
 * Check if a segment is an intercept segment.
 * Intercept segments have namespace starting with "intercept:" — both the
 * parallel container (@modal) and its loader segments receive this namespace
 * from intercept-resolution.ts. Regular parallel segments like @sidebar do not.
 * Server-safe: the cache and match pipeline share it.
 */
export function isInterceptSegment(s: { namespace?: string }): boolean {
  return s.namespace?.startsWith("intercept:") === true;
}

/**
 * Split an array of segments into main and intercept groups.
 * Intercept segments are separated for explicit injection into the render tree
 * via the interceptSegments render option.
 */
export function splitInterceptSegments(segments: ResolvedSegment[]): {
  main: ResolvedSegment[];
  intercept: ResolvedSegment[];
} {
  const main: ResolvedSegment[] = [];
  const intercept: ResolvedSegment[] = [];
  for (const s of segments) {
    if (isInterceptSegment(s)) {
      intercept.push(s);
    } else {
      main.push(s);
    }
  }
  return { main, intercept };
}

/**
 * Check if any slot is currently active (has content to render).
 * Active slots indicate an intercept response where a parallel segment
 * (e.g., @modal) has matched and should be rendered.
 */
export function hasActiveIntercept(slots?: Record<string, SlotState>): boolean {
  if (!slots) return false;
  return Object.values(slots).some((slot) => slot.active);
}

/**
 * Check if cached segments contain any intercept segments.
 * Intercept caches shouldn't be used for cached SWR rendering since
 * whether interception happens depends on the current page context.
 */
export function isInterceptOnlyCache(segments: ResolvedSegment[]): boolean {
  return segments.some(isInterceptSegment);
}

/**
 * An intercept's `matched`: the client's ids without any of the slot's (its
 * id and every loader segment on it, another intercept's into the same slot
 * included), then the slot's (interceptSegmentIds). One order for the
 * prefetch, its fill, an action and a revisit: a fill whose `matched` differs
 * from its tree's is rendered as a new tree (browser/partial-update.ts
 * fillHoles). Shared by router/match-result.ts and wholeInterceptMatched.
 */
export function interceptMatched(
  clientIds: readonly string[],
  slotIds: readonly string[],
): string[] {
  // loaderParentId leaves a non-loader id as it is: the slot's own id goes too.
  return [
    ...clientIds.filter((id) => loaderParentId(id) !== slotIds[0]),
    ...slotIds,
  ];
}

/**
 * The `matched` the browser keeps for an intercept answer to a request that
 * held no segments (a followed redirect, a Back/Forward revalidation with
 * handles pending, the dev HMR refetch), or undefined to keep the answer's.
 * The server never renders the page under an intercept and lists it only
 * from the ids a request held, so such an answer has an empty outlet under
 * the slot. The page it lands over (`held`) stays, as the server lists it for
 * a request that holds it.
 */
export function wholeInterceptMatched(
  held: readonly ResolvedSegment[],
  answer: {
    matched?: string[];
    segments?: ResolvedSegment[];
    slots?: Record<string, SlotState>;
  },
): string[] | undefined {
  if (!hasActiveIntercept(answer.slots)) return undefined;
  const heldIds = held.filter((s) => !isPlaceholder(s)).map((s) => s.id);
  if (heldIds.length === 0) return undefined;
  const slot = answer.segments?.find(
    (s) => isInterceptSegment(s) && s.type !== "loader",
  );
  if (!slot) return undefined;
  const slotLoaderIds = (answer.matched ?? []).filter(
    (id) => id !== slot.id && loaderParentId(id) === slot.id,
  );
  return interceptMatched(heldIds, [slot.id, ...slotLoaderIds]);
}
