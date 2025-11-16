import type { RouteRevalidateFn } from "rsc-router";
import type { shopRoutes } from "@/routes.js";

export const productDetailRevalidation: RouteRevalidateFn<
  typeof shopRoutes,
  "products.detail"
> = ({
  currentParams,
  nextParams,
  method,
  segmentType,
  defaultShouldRevalidate,
}) => {
  console.log("productDetailRevalidation", {
    currentParams,
    nextParams,
    method,
    segmentType,
  });

  if (method == "POST" && segmentType === "route") {
    return true;
  }
  // Only revalidate if it's a route or route-specific layout/parallel
  if (segmentType === "route") {
    return currentParams.slug !== nextParams.slug;
  }

  return { defaultShouldRevalidate };
};
