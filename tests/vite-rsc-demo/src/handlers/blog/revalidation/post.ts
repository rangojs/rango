import type { Revalidate } from "@rangojs/router";

export const postRevalidation: Revalidate<{ slug: string }> = ({
  currentParams,
  nextParams,
  defaultShouldRevalidate,
}) => {
  console.log(
    `[Blog] Checking revalidation: ${currentParams.slug} → ${nextParams.slug}`,
  );
  // Defer to default: true if slug changed, false otherwise
  return defaultShouldRevalidate;
};
