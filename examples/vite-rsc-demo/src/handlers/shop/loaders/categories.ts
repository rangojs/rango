import { createLoader } from "rsc-router/client";
import { categories } from "../data.js";

/**
 * Categories Loader - fetches product categories
 *
 * Used for navigation sidebar and category filtering.
 */
export const CategoriesLoader = createLoader("categories", async (_ctx) => {
  "use server";
  await new Promise((resolve) => setTimeout(resolve, 25));
  return categories;
});
