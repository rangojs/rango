/**
 * Client-safe href function
 *
 * Uses the globally registered route map for runtime URL generation.
 * Types come from RSCRouter.RegisteredRoutes module augmentation.
 */

import { createHref, type HrefFunction } from "../href.js";
import { getGlobalRouteMap } from "../route-map-builder.js";
import type { GetRegisteredRoutes } from "../types.js";

/**
 * Type-safe URL builder for registered routes
 *
 * This function uses:
 * - Types from RSCRouter.RegisteredRoutes (via module augmentation)
 * - Runtime route map from registerRouteMap()
 *
 * @example
 * ```typescript
 * import { href } from "rsc-router/browser";
 *
 * // Types come from module augmentation in routes.ts
 * href("shop.cart");  // "/shop/cart"
 * href("blog.post", { slug: "hello" });  // "/blog/hello"
 * ```
 */
export const href: HrefFunction<GetRegisteredRoutes> = ((
  name: string,
  params?: Record<string, string>
) => {
  const routeMap = getGlobalRouteMap();
  const hrefFn = createHref(routeMap);
  return hrefFn(name as any, params as any);
}) as HrefFunction<GetRegisteredRoutes>;
