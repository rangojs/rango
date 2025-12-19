import { createLoader } from "rsc-router/client";

export type Cart = {
  items: { productId: number; quantity: number; price: number }[];
  total: number;
  itemCount: number;
};

const mockCart: Cart = {
  items: [
    { productId: 1, quantity: 2, price: 99.99 },
    { productId: 3, quantity: 1, price: 149.99 },
  ],
  total: 349.97,
  itemCount: 3,
};

/**
 * Cart Loader - fetches current cart data
 *
 * Available throughout the shop to display cart count in header,
 * cart contents in cart page, and order summary in checkout.
 */
export const CartLoader = createLoader("cart", async (_ctx) => {
  "use server";
  await new Promise((resolve) => setTimeout(resolve, 75));
  return mockCart;
});
