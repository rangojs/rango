import type { Revalidate } from "@rangojs/router/server";

export const orderDetailRevalidation: Revalidate<{ id: string }> = ({
  currentParams,
  nextParams,
  defaultShouldRevalidate,
}) => {
  console.log(`[Shop] Order detail: ${currentParams.id} → ${nextParams.id}`);
  return defaultShouldRevalidate; // Revalidate when ID changes
};
