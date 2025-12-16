import { createLoader } from "rsc-router/server";
import { getCart } from "../actions/shop.actions.js";

export type ProductCartData = {
  productId: string;
  quantity: number;
};

/**
 * Product Cart Loader - fetches cart quantity for a specific product
 *
 * This loader gets the cart and returns how many of the current product
 * are in the cart. Useful for displaying "X in cart" in product modals.
 */
export const ProductCartLoader = createLoader("productCart", async (ctx) => {
  "use server";

  const { slug } = ctx.params;
  console.log(`[ProductCartLoader] Loading cart quantity for ${slug}...`);

  const cart = await getCart();
  const item = cart?.items.find((item) => item.productId === slug);
  const quantity = item?.quantity ?? 0;

  console.log(`[ProductCartLoader] Product ${slug} has ${quantity} in cart`);

  return {
    productId: slug,
    quantity,
  };
});
