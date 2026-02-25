import { createLoader } from "@rangojs/router";
import { products } from "../data.js";
import { ProductLoader } from "./product.js";

/**
 * Related Products Loader - fetches products related to the current one
 *
 * This loader depends on ProductLoader to get the current product's category.
 */
export const RelatedProductsLoader = createLoader(async (ctx) => {
  "use server";

  const product = await ctx.use(ProductLoader);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const related = products
    .filter((p) => p.category === product.category && p.id !== product.id)
    .slice(0, 4);

  return related;
});
