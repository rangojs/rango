import type { Revalidate } from "@rangojs/router/server";

export const cartRevalidation: Revalidate = () => {
  console.log("[Shop] Cart always revalidates (fresh data)");
  return true; // Always refresh cart
};
