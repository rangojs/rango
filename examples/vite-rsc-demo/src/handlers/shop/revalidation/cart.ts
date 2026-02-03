import type { ShouldRevalidateFn } from "@rangojs/router/server";

export const cartRevalidation: ShouldRevalidateFn = () => {
  console.log("[Shop] Cart always revalidates (fresh data)");
  return true; // Always refresh cart
};
