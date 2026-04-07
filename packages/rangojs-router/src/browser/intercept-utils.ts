import type { ResolvedSegment } from "./types.js";
import type { SlotState } from "../types.js";

/**
 * Check if a segment is an intercept segment.
 * Intercept segments have namespace starting with "intercept:" — both the
 * parallel container (@modal) and its content children receive this namespace
 * from intercept-resolution.ts. Regular parallel segments like @sidebar do not.
 */
export function isInterceptSegment(s: ResolvedSegment): boolean {
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
