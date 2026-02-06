import type { Revalidate } from "@rangojs/router/server";

export const productDetailRevalidation: Revalidate<{ slug: string }> = ({
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
