import type { RouteRevalidateFn } from "@ivogt/rsc-router/server";
import type { shopRoutes } from "@/routes.js";

export const checkoutConfirmRevalidation: RouteRevalidateFn<
  typeof shopRoutes,
  "checkout.confirm"
> = () => {
    console.log("[Shop] Checkout confirmation never revalidates");
    return false; // Static confirmation page
  };
