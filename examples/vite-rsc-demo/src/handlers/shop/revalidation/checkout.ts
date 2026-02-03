import type { Revalidate } from "@rangojs/router/server";

export const checkoutConfirmRevalidation: Revalidate = () => {
  console.log("[Shop] Checkout confirmation never revalidates");
  return false; // Static confirmation page
};
