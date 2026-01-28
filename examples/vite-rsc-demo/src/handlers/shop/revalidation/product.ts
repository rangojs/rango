import type { RouteRevalidateFn } from "@ivogt/rsc-router/server";
import type { shopRoutes } from "@/routes.js";

export const productDetailRevalidation: RouteRevalidateFn<
  typeof shopRoutes,
  "shop.products.detail.view"
> = ({
  currentParams,
  nextParams,
  method,
  defaultShouldRevalidate,
}) => {
  console.log("productDetailRevalidation", {
    currentParams,
    nextParams,
    method,
  });

  // Revalidate on POST (after actions)
  if (method === "POST") {
    return true;
  }

  // Revalidate if slug changes
  return currentParams.slug !== nextParams.slug;
};
