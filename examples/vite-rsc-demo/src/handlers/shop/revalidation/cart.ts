import type { RouteRevalidateFn } from "@rangojs/router/server";
import type { shopRoutes } from "@/routes.js";

export const cartRevalidation: RouteRevalidateFn<typeof shopRoutes, "shop.cart"> =
  () => {
  console.log("[Shop] Cart always revalidates (fresh data)");
  return true; // Always refresh cart
};
