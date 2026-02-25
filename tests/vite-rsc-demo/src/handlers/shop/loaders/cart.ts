import { createLoader } from "@rangojs/router";
import { getCart } from "../actions/shop.actions.js";

export type Cart = {
  items: { productId: string; quantity: number; price: number }[];
  total: number;
  itemCount: number;
};

// Price lookup for demo products
const productPrices: Record<string, number> = {
  "wireless-headphones": 99.99,
  "running-shoes": 79.99,
  "coffee-maker": 149.99,
  "laptop-stand": 49.99,
  "yoga-mat": 29.99,
  "desk-lamp": 39.99,
  "mechanical-keyboard": 129.99,
  "water-bottle": 24.99,
  "air-purifier": 199.99,
  "wireless-mouse": 34.99,
};

/**
 * Cart Loader - fetches current cart data
 *
 * Available throughout the shop to display cart count in header,
 * cart contents in cart page, and order summary in checkout.
 */
export const CartLoader = createLoader(async (_ctx) => {
  "use server";
  await new Promise((resolve) => setTimeout(resolve, 75));

  const cart = await getCart();

  if (!cart || cart.items.length === 0) {
    return {
      items: [],
      total: 0,
      itemCount: 0,
    };
  }

  // Build cart with prices
  const items = cart.items.map((item) => ({
    productId: item.productId,
    quantity: item.quantity,
    price: productPrices[item.productId] ?? 0,
  }));

  const total = items.reduce(
    (sum, item) => sum + item.price * item.quantity,
    0,
  );
  const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);

  return {
    items,
    total,
    itemCount,
  };
});
