"use client";

import { useState, useCallback } from "react";

interface Product {
  id: string;
  name: string;
  price: number;
  description: string;
}

interface CartItem {
  itemId: string;
  productId: string;
  quantity: number;
}

export function ShopPlayground({ baseUrl }: { baseUrl: string }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [lastResponse, setLastResponse] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  const api = useCallback(
    async (path: string, init?: RequestInit) => {
      setLoading(true);
      try {
        const res = await fetch(`${baseUrl}${path}`, init);
        const json = await res.json();
        setLastResponse(json);
        return json;
      } catch (err) {
        setLastResponse({ error: { message: String(err) } });
        return null;
      } finally {
        setLoading(false);
      }
    },
    [baseUrl],
  );

  const loadCatalog = async () => {
    const result = await api("/catalog");
    if (result?.products) {
      setProducts(result.products);
    }
  };

  const loadCart = async () => {
    const result = await api("/cart");
    if (result?.items) {
      setCart(result.items);
    }
  };

  const addToCart = async (productId: string) => {
    const result = await api("/cart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId, quantity: 1 }),
    });
    if (result?.items) {
      setCart(result.items);
    }
  };

  const updateQuantity = async (itemId: string, quantity: number) => {
    const result = await api(`/cart/${itemId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quantity }),
    });
    if (result?.item) {
      await loadCart();
    }
  };

  const replaceItem = async (
    itemId: string,
    productId: string,
    quantity: number,
  ) => {
    await api(`/cart/${itemId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId, quantity }),
    });
    await loadCart();
  };

  const removeItem = async (itemId: string) => {
    await api(`/cart/${itemId}`, { method: "DELETE" });
    await loadCart();
  };

  const clearCart = async () => {
    await api("/cart", { method: "DELETE" });
    setCart([]);
  };

  const checkHealth = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/health`, { method: "HEAD" });
      setLastResponse({ head: { ok: res.ok, status: res.status } });
    } finally {
      setLoading(false);
    }
  };

  const getHealth = async () => {
    await api("/health");
  };

  return (
    <div
      data-testid="shop-playground"
      style={{ padding: "1rem", fontFamily: "system-ui" }}
    >
      <h1 data-testid="playground-title">Shop API Playground</h1>

      {/* Catalog Section */}
      <section data-testid="catalog-section" style={{ marginBottom: "2rem" }}>
        <h2>Catalog</h2>
        <button
          data-testid="load-catalog-btn"
          onClick={loadCatalog}
          disabled={loading}
        >
          Load Catalog
        </button>
        <div data-testid="product-list" style={{ marginTop: "0.5rem" }}>
          {products.map((p) => (
            <div
              key={p.id}
              data-testid={`product-${p.id}`}
              style={{
                padding: "0.5rem",
                border: "1px solid #ccc",
                margin: "0.25rem 0",
              }}
            >
              <strong>{p.name}</strong> - ${p.price}
              <button
                data-testid={`view-product-${p.id}`}
                onClick={() => api(`/catalog/${p.id}`)}
                style={{ marginLeft: "0.5rem" }}
              >
                View Details
              </button>
              <button
                data-testid={`add-to-cart-${p.id}`}
                onClick={() => addToCart(p.id)}
                style={{ marginLeft: "0.5rem" }}
              >
                Add to Cart
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* Cart Section */}
      <section data-testid="cart-section" style={{ marginBottom: "2rem" }}>
        <h2>Cart ({cart.length} items)</h2>
        <button
          data-testid="load-cart-btn"
          onClick={loadCart}
          disabled={loading}
        >
          Load Cart
        </button>
        <button
          data-testid="clear-cart-btn"
          onClick={clearCart}
          disabled={loading}
          style={{ marginLeft: "0.5rem" }}
        >
          Clear Cart
        </button>
        <div data-testid="cart-items" style={{ marginTop: "0.5rem" }}>
          {cart.map((item) => (
            <div
              key={item.itemId}
              data-testid={`cart-item-${item.itemId}`}
              style={{
                padding: "0.5rem",
                border: "1px solid #ccc",
                margin: "0.25rem 0",
              }}
            >
              Product: {item.productId} | Qty: {item.quantity}
              <button
                data-testid={`decrease-${item.itemId}`}
                onClick={() =>
                  updateQuantity(item.itemId, Math.max(1, item.quantity - 1))
                }
                style={{ marginLeft: "0.5rem" }}
              >
                -
              </button>
              <button
                data-testid={`increase-${item.itemId}`}
                onClick={() => updateQuantity(item.itemId, item.quantity + 1)}
                style={{ marginLeft: "0.25rem" }}
              >
                +
              </button>
              <button
                data-testid={`replace-${item.itemId}`}
                onClick={() => replaceItem(item.itemId, "p2", 5)}
                style={{ marginLeft: "0.5rem" }}
              >
                Replace (PUT)
              </button>
              <button
                data-testid={`remove-${item.itemId}`}
                onClick={() => removeItem(item.itemId)}
                style={{ marginLeft: "0.5rem" }}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* Health Section */}
      <section data-testid="health-section" style={{ marginBottom: "2rem" }}>
        <h2>Health</h2>
        <button
          data-testid="health-head-btn"
          onClick={checkHealth}
          disabled={loading}
        >
          HEAD Check
        </button>
        <button
          data-testid="health-get-btn"
          onClick={getHealth}
          disabled={loading}
          style={{ marginLeft: "0.5rem" }}
        >
          GET Health
        </button>
      </section>

      {/* Response Log */}
      <section data-testid="response-log-section">
        <h2>Response Log</h2>
        <pre
          data-testid="response-log"
          style={{
            background: "#f5f5f5",
            padding: "1rem",
            borderRadius: "4px",
            maxHeight: "300px",
            overflow: "auto",
            whiteSpace: "pre-wrap",
            fontSize: "12px",
          }}
        >
          {lastResponse
            ? JSON.stringify(lastResponse, null, 2)
            : "No response yet"}
        </pre>
      </section>
    </div>
  );
}
