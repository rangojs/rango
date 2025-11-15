import type { RouteRevalidateFn } from "rsc-router";
import type { shopRoutes } from "@/routes.js";

export const productDetailRevalidation: RouteRevalidateFn<
  typeof shopRoutes,
  "products.detail"
> = ({
  currentParams,
  nextParams,
  method,
}) => {
  console.log("productDetailRevalidation", {
    currentParams,
    nextParams,
    method,
  });

  if (method == "POST") {
    return true;
  }

  return currentParams.slug !== nextParams.slug;
};
