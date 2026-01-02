"use client";

import { use, Suspense, type ReactNode } from "react";
import { useLoader } from "rsc-router/client";
import {
  FeaturedProductsLoader,
  type FeaturedProductsData,
} from "../handlers/shop/loaders/featured-products.js";

/**
 * FeaturedProductsContent - consumes the streaming promise with use()
 */
function FeaturedProductsContent({
  contentPromise,
}: {
  contentPromise: Promise<ReactNode>;
}) {
  // React's use() hook suspends until the promise resolves
  const content = use(contentPromise);
  return <>{content}</>;
}

/**
 * Loading skeleton
 */
function FeaturedProductsLoading() {
  return (
    <div style={{ display: "flex", gap: "1rem" }}>
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          style={{
            border: "2px solid #ddd",
            borderRadius: "8px",
            padding: "1rem",
            width: "200px",
            background: "#f5f5f5",
          }}
        >
          <div
            style={{
              height: "12px",
              background: "#e0e0e0",
              borderRadius: "4px",
              width: "60px",
              marginBottom: "0.5rem",
            }}
          />
          <div
            style={{
              height: "20px",
              background: "#e0e0e0",
              borderRadius: "4px",
              marginBottom: "0.5rem",
            }}
          />
          <div
            style={{
              height: "16px",
              background: "#e0e0e0",
              borderRadius: "4px",
              width: "80px",
            }}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * FeaturedProducts - demonstrates streaming via loader promise
 *
 * The loader returns { content: Promise<ReactNode> }.
 * This component uses React's use() hook with Suspense to
 * consume the promise - the content streams in when ready.
 */
export function FeaturedProducts() {
  const { data } = useLoader(FeaturedProductsLoader);

  return (
    <div
      style={{
        marginTop: "2rem",
        padding: "1rem",
        border: "1px solid #eee",
        borderRadius: "8px",
      }}
    >
      <h3 style={{ marginBottom: "0.5rem" }}>Featured Products</h3>
      <p style={{ fontSize: "0.875rem", color: "#666", marginBottom: "1rem" }}>
        Streaming Demo - Promise&lt;ReactNode&gt; streams via RSC, resolved on
        client with use()
      </p>
      <Suspense fallback={<FeaturedProductsLoading />}>
        <FeaturedProductsContent contentPromise={data.content} />
      </Suspense>
    </div>
  );
}
