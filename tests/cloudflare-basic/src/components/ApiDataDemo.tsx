"use client";

import { useState, useEffect } from "react";
import { href } from "@rangojs/router/client";
import type { ProblemDetails } from "@rangojs/router";

// JSON response routes now send the handler's return value verbatim (bare),
// so Rango.PathResponse<T> is the success payload directly. Errors arrive as
// non-2xx problem+json responses, surfaced here via res.ok / problem.detail.
export function ApiDataDemo() {
  const [health, setHealth] =
    useState<Rango.PathResponse<"/api/health"> | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [products, setProducts] =
    useState<Rango.PathResponse<"/api/products"> | null>(null);
  const [productsError, setProductsError] = useState<string | null>(null);
  const [product, setProduct] =
    useState<Rango.PathResponse<"/api/products/:id"> | null>(null);
  const [productError, setProductError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      const healthRes = await fetch(href("/api/health"));
      if (healthRes.ok) {
        const healthResult: Rango.PathResponse<"/api/health"> =
          await healthRes.json();
        setHealth(healthResult);
      } else {
        const problem: ProblemDetails = await healthRes.json();
        setHealthError(problem.detail);
      }

      const productsRes = await fetch(href("/api/products"));
      if (productsRes.ok) {
        const productsResult: Rango.PathResponse<"/api/products"> =
          await productsRes.json();
        setProducts(productsResult);
      } else {
        const problem: ProblemDetails = await productsRes.json();
        setProductsError(problem.detail);
      }

      const productRes = await fetch(href("/api/products/1"));
      if (productRes.ok) {
        const productResult: Rango.PathResponse<"/api/products/:id"> =
          await productRes.json();
        setProduct(productResult);
      } else {
        const problem: ProblemDetails = await productRes.json();
        setProductError(problem.detail);
      }
    }
    load();
  }, []);

  return (
    <div data-testid="api-demo">
      <h2>API Health</h2>
      <div data-testid="api-health">
        {healthError ? (
          <span data-testid="health-error">{healthError}</span>
        ) : health ? (
          <>
            <span data-testid="health-status">{health.status}</span>
            <span data-testid="health-timestamp">{health.timestamp}</span>
          </>
        ) : (
          <span data-testid="health-loading">Loading...</span>
        )}
      </div>

      <h2>Products</h2>
      <div data-testid="api-products">
        {productsError ? (
          <span data-testid="products-error">{productsError}</span>
        ) : products ? (
          <ul data-testid="products-list">
            {products.map((p) => (
              <li key={p.id} data-testid={`product-${p.id}`}>
                {p.name} - ${p.price}
              </li>
            ))}
          </ul>
        ) : (
          <span data-testid="products-loading">Loading...</span>
        )}
      </div>

      <h2>Product Detail</h2>
      <div data-testid="api-product-detail">
        {productError ? (
          <span data-testid="product-error">{productError}</span>
        ) : product ? (
          <>
            <span data-testid="product-detail-id">{product.id}</span>
            <span data-testid="product-detail-name">{product.name}</span>
            <span data-testid="product-detail-price">{product.price}</span>
            <span data-testid="product-detail-description">
              {product.description}
            </span>
          </>
        ) : (
          <span data-testid="product-loading">Loading...</span>
        )}
      </div>
    </div>
  );
}
