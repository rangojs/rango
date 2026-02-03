import type { ShouldRevalidateFn } from "@rangojs/router/server";

export const postRevalidation: ShouldRevalidateFn<{ slug: string }> = ({
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
