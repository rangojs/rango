import type { MatchedRoute, MatchedSegment } from './types';

/**
 * Find the index where routes diverge
 * Returns the index of the first segment that differs
 */
export function findDivergenceIndex(
  currentRoute: MatchedRoute | null,
  nextRoute: MatchedRoute
): number {
  if (!currentRoute) {
    return 0; // Everything is new
  }

  const currentSegments = currentRoute.segments;
  const nextSegments = nextRoute.segments;

  let divergenceIndex = 0;

  for (
    let i = 0;
    i < Math.min(currentSegments.length, nextSegments.length);
    i++
  ) {
    const current = currentSegments[i];
    const next = nextSegments[i];

    // Safety check - if either is missing, we've diverged
    if (!current || !next) break;

    // Check if paths match (considering dynamic segments)
    const pathsMatch = current.path === next.path;

    // Check if params match (for dynamic segments)
    const paramsMatch =
      JSON.stringify(current.params) === JSON.stringify(next.params);

    // Check if the layout component is the same
    const layoutsMatch = current.layout === next.layout;

    if (!pathsMatch || !paramsMatch || !layoutsMatch) {
      break;
    }

    divergenceIndex = i + 1;
  }

  return divergenceIndex;
}

/**
 * Get the segments that need to be rendered
 * Returns only the new segments starting from the divergence point
 */
export function getChangedSegments(
  currentRoute: MatchedRoute | null,
  nextRoute: MatchedRoute
): {
  divergenceIndex: number;
  preservedSegments: MatchedSegment[];
  newSegments: MatchedSegment[];
  removedSegments: MatchedSegment[];
} {
  const divergenceIndex = findDivergenceIndex(currentRoute, nextRoute);

  const preservedSegments = nextRoute.segments.slice(0, divergenceIndex);
  const newSegments = nextRoute.segments.slice(divergenceIndex);
  const removedSegments = currentRoute
    ? currentRoute.segments.slice(divergenceIndex)
    : [];

  return {
    divergenceIndex,
    preservedSegments,
    newSegments,
    removedSegments,
  };
}

/**
 * Build a component tree from matched segments
 * Used server-side to create the nested component structure
 */
export function buildComponentTree(
  segments: MatchedSegment[],
  _startIndex: number = 0  // Unused but kept for API compatibility
): React.ReactNode {
  if (segments.length === 0) {
    return null;
  }

  // We'll handle this differently since OutletProvider is a client component
  // The actual tree building happens in the router
  return null;
}

/**
 * Extract layout names for debugging and cache keys
 */
export function getLayoutNames(segments: MatchedSegment[]): string[] {
  return segments
    .filter((s) => s.layout)
    .map((s) => s.layout?.name || 'UnnamedLayout');
}

/**
 * Create a cache key for a matched route
 */
export function getRouteCacheKey(route: MatchedRoute): string {
  return route.pathname + JSON.stringify(route.params);
}
