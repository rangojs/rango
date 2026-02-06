/**
 * OPTIONAL: Project-specific type aliases
 *
 * This file demonstrates how you CAN create convenience type aliases
 * for your route handlers, but it's NOT required.
 *
 * The shop example now uses framework types directly:
 * - RouteHandler<typeof shopRoutes, "cart">
 * - RouteRevalidateFn<typeof shopRoutes, "cart">
 * - RouteMiddleware<typeof shopRoutes, "cart">
 *
 * You can create aliases like these if you prefer shorter syntax:
 *
 * @example
 * ```typescript
 * import type { RouteHandler } from "@rangojs/router/server";
 * import type { shopRoutes } from "../../routes.js";
 *
 * // Create convenience alias (OPTIONAL)
 * export type ShopRouteHandler<K extends keyof typeof shopRoutes> =
 *   RouteHandler<typeof shopRoutes, K>;
 *
 * // Use it (shorter syntax)
 * export const cartRoute: ShopRouteHandler<"cart"> = (ctx) => { ... }
 *
 * // vs. using framework types directly (what we do in this example)
 * export const cartRoute: RouteHandler<typeof shopRoutes, "cart"> = (ctx) => { ... }
 * ```
 *
 * For small projects, using framework types directly is clearer and more explicit.
 * For large projects with many handlers, aliases can reduce repetition.
 */
