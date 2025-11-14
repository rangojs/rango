/**
 * rsc-router
 *
 * Type-safe RSC router with partial rendering support
 */

// Core router
export { createRSCRouter, type RSCRouter } from './router.js';

// Route definitions and helper functions
export { route, map, layout, parallel, middleware, revalidate } from './route-definition.js';

// Segment system
export { renderSegments } from './segment-system.js';

// Types
export type {
  RouterEnv,
  DefaultEnv,
  RouteDefinition,
  ResolvedRouteMap,
  Handler,
  HandlerContext,
  HandlersForRouteMap,
  ResolvedSegment,
  SegmentMetadata,
  MatchResult,
  ExtractParams,
  GenericParams,
  RevalidateParams,
  ShouldRevalidateFn,
  MiddlewareFn,
  RouteKeys,
} from './types.js';
