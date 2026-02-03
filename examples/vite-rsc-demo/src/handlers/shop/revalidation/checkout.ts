import type { RouteRevalidateFn } from "@rangojs/router/server";
import type { shopRoutes } from "@/routes.js";

export const checkoutConfirmRevalidation: RouteRevalidateFn<
  typeof shopRoutes,
  "shop.checkout.confirm"
> = () => {
    console.log("[Shop] Checkout confirmation never revalidates");
    return false; // Static confirmation page
  };
