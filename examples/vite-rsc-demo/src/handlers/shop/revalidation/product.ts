import type { ShouldRevalidateFn } from "@rangojs/router/server";

export const productDetailRevalidation: ShouldRevalidateFn<{ slug: string }> = ({
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
