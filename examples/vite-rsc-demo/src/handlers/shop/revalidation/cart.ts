import type { RouteRevalidateFn } from "@ivogt/rsc-router/server";
import type { shopRoutes } from "@/routes.js";

export const cartRevalidation: RouteRevalidateFn<typeof shopRoutes, "cart"> =
  () => {
  console.log("[Shop] Cart always revalidates (fresh data)");
  return true; // Always refresh cart
};
