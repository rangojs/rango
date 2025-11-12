/**
 * rsc-router
 *
 * Type-safe RSC router with partial rendering support
 */

// Core router
export { createRSCRouter, type RSCRouter } from './router.js';

// Route definitions and symbols (route is a function with symbol properties)
export { route, map } from './route-definition.js';

// Segment system
export { renderSegments } from './segment-system.js';

// Types
export type {
  RouteDefinition,
  ResolvedRouteMap,
  Handler,
  HandlerContext,
  HandlersForRouteMap,
  ResolvedSegment,
  SegmentMetadata,
  MatchResult,
  ExtractParams,
  RevalidateFn,
} from './types.js';
