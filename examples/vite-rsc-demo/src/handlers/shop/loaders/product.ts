import { createLoader } from "rsc-router/server";
import { products } from "../data.js";

export type Product = {
  id: number;
  slug: string;
  name: string;
  category: string;
  price: number;
  description: string;
};

/**
 * Product Loader - fetches a single product by slug
 *
 * This loader depends on route params, so it's typically attached
 * at the product detail route level.
 *
 * Type-safe: ctx.params.slug is typed as string
 */
export const ProductLoader = createLoader("product", async (ctx) => {
  "use server";

  const { slug } = ctx.params;
  // 2 second delay to demonstrate loading skeleton
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const product = products.find((p) => p.slug === slug);
  if (!product) {
    throw new Error(`Product not found: ${slug}`);
  }

  return product; // Return type (Product) is inferred!
});
