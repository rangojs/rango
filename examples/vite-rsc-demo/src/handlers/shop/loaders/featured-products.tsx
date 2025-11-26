import type { ReactNode } from "react";
import { createLoader } from "rsc-router/loader";
import { products } from "../data.js";
import type { Product } from "./product.js";

/**
 * Featured Products Loader - demonstrates streaming Promise<ReactNode>
 *
 * This loader returns { content: Promise<ReactNode> }. The promise is NOT awaited
 * by the router - it's serialized via RSC and streamed to the client.
 *
 * A client component uses React's use() hook with Suspense to consume the promise
 * and render the content when it resolves.
 *
 * Usage:
 *   // In server component - get the loader data
 *   const data = ctx.use(FeaturedProductsLoader);
 *
 *   // In client component - consume the streaming promise
 *   const content = use(data.content);
 *   return <>{content}</>;
 */
export const FeaturedProductsLoader = createLoader<FeaturedProductsData>(
  "featuredProducts",
  async (_ctx) => {
    "use server";

    // Return immediately with a promise that resolves later
    // This promise streams via RSC - not awaited on server
    const contentPromise = new Promise<ReactNode>((resolve) => {
      setTimeout(() => {
        const featuredProducts = products.slice(0, 3);

        resolve(
          <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
            {featuredProducts.map((product: Product) => (
              <div
                key={product.id}
                style={{
                  border: "2px solid gold",
                  borderRadius: "8px",
                  padding: "1rem",
                  width: "200px",
                  background: "linear-gradient(135deg, #fff9e6 0%, #fff 100%)",
                }}
              >
                <div
                  style={{
                    fontSize: "0.75rem",
                    color: "goldenrod",
                    fontWeight: "bold",
                  }}
                >
                  FEATURED
                </div>
                <h4 style={{ margin: "0.5rem 0" }}>{product.name}</h4>
                <p style={{ fontSize: "0.875rem", color: "#666" }}>
                  ${product.price.toFixed(2)}
                </p>
              </div>
            ))}
          </div>
        );
      }, 3000);
    });

    return {
      content: contentPromise,
    };
  }
);

export type FeaturedProductsData = {
  content: Promise<ReactNode>;
};
