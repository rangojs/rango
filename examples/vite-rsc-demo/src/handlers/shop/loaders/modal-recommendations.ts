import { createLoader } from "rsc-router";
import { products } from "../data.js";

export type Recommendation = {
  id: number;
  slug: string;
  name: string;
  price: number;
};

/**
 * Modal Recommendations Loader - fetches recommendations with delay
 *
 * This loader demonstrates streaming content after an action.
 * It has a 2 second delay and revalidates when cart actions occur,
 * so after adding to cart, the recommendations will stream in.
 */
export const ModalRecommendationsLoader = createLoader(async (ctx) => {
    "use server";

    const { slug } = ctx.params;
    console.log(`[ModalRecommendationsLoader] Loading recommendations for ${slug}...`);

    // 2 second delay to demonstrate streaming after action
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Get 3 random products that aren't the current one
    const recommendations = products
      .filter((p) => p.slug !== slug)
      .sort(() => Math.random() - 0.5)
      .slice(0, 3)
      .map((p) => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
        price: p.price,
      }));

    console.log(`[ModalRecommendationsLoader] Loaded ${recommendations.length} recommendations`);

    return {
      recommendations,
      loadedAt: new Date().toISOString(),
    };
  }
);
