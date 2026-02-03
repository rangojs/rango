import type { RouteRevalidateFn } from "@rangojs/router/server";
import type { shopRoutes } from "@/routes.js";

export const orderDetailRevalidation: RouteRevalidateFn<
  typeof shopRoutes,
  "shop.account.orderDetail"
> = ({
  currentParams,
  nextParams,
  defaultShouldRevalidate,
}) => {
  console.log(`[Shop] Order detail: ${currentParams.id} → ${nextParams.id}`);
  return defaultShouldRevalidate; // Revalidate when ID changes
};
