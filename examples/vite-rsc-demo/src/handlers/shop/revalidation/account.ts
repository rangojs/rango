import type { ShouldRevalidateFn } from "@rangojs/router/server";

export const orderDetailRevalidation: ShouldRevalidateFn<{ id: string }> = ({
  currentParams,
  nextParams,
  defaultShouldRevalidate,
}) => {
  console.log(`[Shop] Order detail: ${currentParams.id} → ${nextParams.id}`);
  return defaultShouldRevalidate; // Revalidate when ID changes
};
