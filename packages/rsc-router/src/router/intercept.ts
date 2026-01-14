/**
 * Router Intercept Utilities
 *
 * Pure functions for intercept activation decisions.
 */

/**
 * Parameters for determining if intercept lookup should be attempted
 */
export interface ShouldLookupInterceptParams {
  /** Whether navigating within the same route (e.g., product/a -> product/b). Can be null/false. */
  isSameRouteNavigation: boolean | null;
  /** Whether this is an action request */
  isAction: boolean;
  /** Set of segment IDs the client currently has */
  clientSegmentSet: Set<string>;
}

/**
 * Determine if we should attempt to find an intercept for the current navigation.
 *
 * This is a pre-check before calling findInterceptForRoute. We skip intercept
 * lookup entirely in certain cases:
 *
 * 1. Same route navigation (e.g., /product/1 -> /product/2): The user is
 *    navigating within the same route, which means they want to leave any
 *    modal/intercept and see the actual route content.
 *
 * 2. Action without intercept segments: For actions, if the client doesn't
 *    have any intercept segments (segment IDs containing ".@"), they're on
 *    the detail page, not the intercepted view. Running the action should
 *    not incorrectly render intercepts.
 *
 * For navigation (non-action), we always look for intercepts since the client
 * might be navigating to open one.
 *
 * @param params - Decision parameters
 * @returns true if we should attempt intercept lookup, false to skip
 *
 * @example
 * ```typescript
 * const shouldLookup = shouldLookupIntercept({
 *   isSameRouteNavigation: false,
 *   isAction: false,
 *   clientSegmentSet: new Set(['M1L0C0', 'M1L0C0L0']),
 * });
 *
 * if (shouldLookup) {
 *   const interceptResult = findInterceptForRoute(...);
 * }
 * ```
 */
export function shouldLookupIntercept(
  params: ShouldLookupInterceptParams
): boolean {
  const { isSameRouteNavigation, isAction, clientSegmentSet } = params;

  // Skip intercepts when navigating within the same route
  // User wants to leave the modal and see the actual route content
  if (isSameRouteNavigation) {
    return false;
  }

  // For actions, only look for intercepts if client has intercept segments
  // Otherwise they're on the detail page, not the intercepted view
  if (isAction) {
    const clientHasInterceptSegments = [...clientSegmentSet].some((id) =>
      id.includes(".@")
    );
    return clientHasInterceptSegments;
  }

  // For navigation, always look for intercepts
  return true;
}

/**
 * Check if any segment ID indicates the client has active intercepts
 *
 * Intercept segment IDs contain ".@" (e.g., "M1L0C0L0.@modal")
 *
 * @param clientSegmentSet - Set of segment IDs the client currently has
 * @returns true if client has any intercept segments
 */
export function clientHasInterceptSegments(
  clientSegmentSet: Set<string>
): boolean {
  for (const id of clientSegmentSet) {
    if (id.includes(".@")) {
      return true;
    }
  }
  return false;
}
