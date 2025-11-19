import type { RouteRevalidateFn } from "rsc-router/server";
import type { blogRoutes } from "@/routes.js";

export const postRevalidation: RouteRevalidateFn<typeof blogRoutes, "post"> = ({
  currentParams,
  nextParams,
  defaultShouldRevalidate,
}) => {
  console.log(
    `[Blog] Checking revalidation: ${currentParams.slug} → ${nextParams.slug}`
  );
  // Defer to default: true if slug changed, false otherwise
  return defaultShouldRevalidate;
};
