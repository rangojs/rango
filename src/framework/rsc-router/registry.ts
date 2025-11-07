import type { ExtractRouteParams } from "./types";
import type { ExtractRoutePaths } from "./route-paths";

/**
 * Global route registry for type augmentation
 *
 * Users should augment this interface with their route definitions:
 *
 * @example
 * declare module "@/framework/rsc-router/registry" {
 *   interface RouteRegistry {
 *     routes: typeof myRoutes;
 *   }
 * }
 */
export interface RouteRegistry {
  // This will be augmented by user code
  // When not augmented, it's an empty object
}

/**
 * Extract all valid paths from registered routes
 * Falls back to never if routes are not registered (forces registration)
 */
export type ValidRoutePaths = RouteRegistry extends { routes: infer R }
  ? ExtractRoutePaths<R>
  : never;

/**
 * Extract parameters for a specific route path
 *
 * @example
 * type Params = RouteParams<"/items/:id">
 * // Result: { id: string }
 */
export type RouteParams<TPath extends string> = ExtractRouteParams<TPath>;

/**
 * Check if a path has parameters
 */
export type HasParams<TPath extends string> = keyof RouteParams<TPath> extends never
  ? false
  : true;
