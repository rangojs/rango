import type { ShouldRevalidateFn } from "@rangojs/router/server";

export const checkoutConfirmRevalidation: ShouldRevalidateFn = () => {
  console.log("[Shop] Checkout confirmation never revalidates");
  return false; // Static confirmation page
};
