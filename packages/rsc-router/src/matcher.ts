import type { RouteSegment, MatchedRoute, MatchedSegment } from './types';

/**
 * Parse URL pathname into segments
 */
export function parsePathname(pathname: string): string[] {
  return pathname.split('/').filter(Boolean).map(decodeURIComponent);
}

/**
 * Check if a segment matches a route pattern
 */
function matchSegment(
  urlSegment: string,
  routeSegment: string
): { match: boolean; params?: Record<string, string> } {
  // Exact match
  if (routeSegment === urlSegment) {
    return { match: true };
  }

  // Dynamic segment (e.g., :id)
  if (routeSegment.startsWith(':')) {
    const paramName = routeSegment.slice(1);
    return {
      match: true,
      params: { [paramName]: urlSegment },
    };
  }

  // Catch-all segment
  if (routeSegment === '*') {
    return {
      match: true,
      params: { '*': urlSegment },
    };
  }

  return { match: false };
}

/**
 * Match a URL pathname against a route tree
 * Returns matched route with all segments and params
 */
export function matchRoute(
  pathname: string,
  routeTree: RouteSegment
): MatchedRoute | null {
  const urlSegments = parsePathname(pathname);
  const matchedSegments: MatchedSegment[] = [];
  const allParams: Record<string, string> = {};

  function traverse(
    route: RouteSegment,
    remainingSegments: string[],
    depth: number
  ): boolean {
    // Add root layout if at depth 0
    if (depth === 0 && route.layout) {
      matchedSegments.push({
        path: '/',
        params: {},
        layout: route.layout,
        meta: route.meta,
      });
    }

    // If no more segments and we have a page, we found a match
    if (remainingSegments.length === 0) {
      if (route.page) {
        matchedSegments.push({
          path: route.path,
          params: {},
          page: route.page,
          meta: route.meta,
        });
        return true;
      }
      // Check if any child is an index route
      const indexChild = route.children?.find(
        (child) => child.path === '' || child.path === 'index'
      );
      if (indexChild?.page) {
        matchedSegments.push({
          path: '',
          params: {},
          page: indexChild.page,
          meta: indexChild.meta,
        });
        return true;
      }
      return false;
    }

    const currentSegment = remainingSegments[0];
    const nextSegments = remainingSegments.slice(1);

    // Try to match children
    if (route.children) {
      // Sort children by specificity (static > dynamic > catch-all)
      const sortedChildren = [...route.children].sort((a, b) => {
        if (a.isCatchAll) return 1;
        if (b.isCatchAll) return -1;
        if (a.isDynamic) return 1;
        if (b.isDynamic) return -1;
        return 0;
      });

      for (const child of sortedChildren) {
        const childPath = child.path;
        if (!childPath) continue; // Skip if path is undefined
        const { match, params } = matchSegment(currentSegment, childPath as string);

        if (match) {
          const segment: MatchedSegment = {
            path: child.path,
            params: params || {},
            meta: child.meta,
          };

          if (child.layout) {
            segment.layout = child.layout;
          }

          // For leaf nodes, check if this is the final segment
          if (nextSegments.length === 0 && child.page) {
            segment.page = child.page;
          }

          matchedSegments.push(segment);

          if (params) {
            Object.assign(allParams, params);
          }

          // Continue traversing if we have more segments or if this child has children
          if (nextSegments.length > 0 || child.children) {
            if (traverse(child, nextSegments, depth + 1)) {
              return true;
            }
          } else if (child.page) {
            // This is a leaf node with a page
            return true;
          }

          // Backtrack if no match found
          matchedSegments.pop();
          if (params) {
            Object.keys(params).forEach((key) => delete allParams[key]);
          }
        }
      }
    }

    return false;
  }

  if (traverse(routeTree, urlSegments, 0)) {
    return {
      pathname,
      segments: matchedSegments,
      params: allParams,
    };
  }

  return null;
}

/**
 * Generate a path from route name and params
 */
export function generatePath(
  pattern: string,
  params?: Record<string, string>
): string {
  let path = pattern;

  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      path = path.replace(`:${key}`, encodeURIComponent(value));
    });
  }

  return path;
}
