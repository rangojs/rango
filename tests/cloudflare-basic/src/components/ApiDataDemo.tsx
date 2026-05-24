"use client";

import { useState, useEffect } from "react";
import { href } from "@rangojs/router/client";

export function ApiDataDemo() {
  const [health, setHealth] =
    useState<Rango.PathResponse<"/api/health"> | null>(null);
  const [products, setProducts] =
    useState<Rango.PathResponse<"/api/products"> | null>(null);
  const [product, setProduct] =
    useState<Rango.PathResponse<"/api/products/:id"> | null>(null);

  useEffect(() => {
    async function load() {
      const healthResult: Rango.PathResponse<"/api/health"> = await fetch(
        href("/api/health"),
      ).then((r) => r.json());
      setHealth(healthResult);

      const productsResult: Rango.PathResponse<"/api/products"> = await fetch(
        href("/api/products"),
      ).then((r) => r.json());
      setProducts(productsResult);

      const productResult: Rango.PathResponse<"/api/products/:id"> =
        await fetch(href("/api/products/1")).then((r) => r.json());
      setProduct(productResult);
    }
    load();
  }, []);

  return (
    <div data-testid="api-demo">
      <h2>API Health</h2>
      <div data-testid="api-health">
        {health ? (
          health.error ? (
            <span data-testid="health-error">{health.error.message}</span>
          ) : (
            <>
              <span data-testid="health-status">{health.data.status}</span>
              <span data-testid="health-timestamp">
                {health.data.timestamp}
              </span>
            </>
          )
        ) : (
          <span data-testid="health-loading">Loading...</span>
        )}
      </div>

      <h2>Products</h2>
      <div data-testid="api-products">
        {products ? (
          products.error ? (
            <span data-testid="products-error">{products.error.message}</span>
          ) : (
            <ul data-testid="products-list">
              {products.data.map((p) => (
                <li key={p.id} data-testid={`product-${p.id}`}>
                  {p.name} - ${p.price}
                </li>
              ))}
            </ul>
          )
        ) : (
          <span data-testid="products-loading">Loading...</span>
        )}
      </div>

      <h2>Product Detail</h2>
      <div data-testid="api-product-detail">
        {product ? (
          product.error ? (
            <span data-testid="product-error">{product.error.message}</span>
          ) : (
            <>
              <span data-testid="product-detail-id">{product.data.id}</span>
              <span data-testid="product-detail-name">{product.data.name}</span>
              <span data-testid="product-detail-price">
                {product.data.price}
              </span>
              <span data-testid="product-detail-description">
                {product.data.description}
              </span>
            </>
          )
        ) : (
          <span data-testid="product-loading">Loading...</span>
        )}
      </div>
    </div>
  );
}
