"use client";

import { useState, useTransition } from "react";
import { useLoader } from "rsc-router/client";
import { Link } from "rsc-router/browser";
import { ProductLoader } from "../loaders/product.js";
import { CartLoader } from "../loaders/cart.js";
import { addToCart } from "../actions/shop.actions.js";

const styles = {
  header: {
    padding: "1.5rem",
    borderBottom: "1px solid #e2e8f0",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
    borderRadius: "8px 8px 0 0",
  },
  title: {
    fontSize: "1.25rem",
    fontWeight: 600,
    color: "white",
    margin: 0,
    flex: 1,
  },
  body: {
    padding: "1.5rem",
  },
  section: {
    marginBottom: "1.5rem",
  },
  sectionTitle: {
    fontSize: "0.75rem",
    fontWeight: 600,
    color: "#64748b",
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
    marginBottom: "0.5rem",
  },
  categoryBadge: {
    display: "inline-block",
    background: "#f1f5f9",
    color: "#475569",
    padding: "0.25rem 0.75rem",
    borderRadius: "4px",
    fontSize: "0.875rem",
    fontWeight: 500,
    textTransform: "capitalize" as const,
  },
  price: {
    fontSize: "1.5rem",
    fontWeight: 700,
    color: "#667eea",
  },
  description: {
    color: "#475569",
    lineHeight: 1.6,
  },
  buttonGroup: {
    display: "flex",
    gap: "0.5rem",
    marginTop: "1rem",
  },
  addToCartButton: {
    background: "#667eea",
    color: "white",
    border: "none",
    padding: "0.75rem 1.5rem",
    borderRadius: "6px",
    cursor: "pointer",
    fontSize: "0.875rem",
    fontWeight: 500,
    flex: 1,
  },
  cancelButton: {
    background: "#f1f5f9",
    color: "#64748b",
    border: "none",
    padding: "0.75rem 1rem",
    borderRadius: "6px",
    cursor: "pointer",
    fontSize: "0.875rem",
  },
  pending: {
    cursor: "wait" as const,
    opacity: 0.7,
  },
  cartInfo: {
    fontSize: "0.875rem",
    color: "#64748b",
    marginTop: "0.5rem",
  },
};

// Modal content for product detail - rendered inside ProductModalOverlay
// The overlay and close handling is done by ProductModalOverlay
export function ProductDetailContent() {
  const product = useLoader(ProductLoader);
  const cart = useLoader(CartLoader);
  const [isPending, startTransition] = useTransition();
  const [addedMessage, setAddedMessage] = useState<string | null>(null);

  function handleAddToCart() {
    startTransition(async () => {
      await addToCart(String(product.id));
      setAddedMessage(`Added ${product.name} to cart!`);
      setTimeout(() => setAddedMessage(null), 2000);
    });
  }

  return (
    <>
      <div style={styles.header}>
        <h2 style={styles.title}>{product.name}</h2>
      </div>

      <div style={styles.body}>
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Category</div>
          <span style={styles.categoryBadge}>{product.category}</span>
        </div>

        <div style={styles.section}>
          <div style={styles.sectionTitle}>Price</div>
          <div style={styles.price}>${product.price}</div>
        </div>

        <div style={styles.section}>
          <div style={styles.sectionTitle}>Description</div>
          <div style={styles.description}>{product.description}</div>
        </div>

        <div style={styles.section}>
          <div style={styles.sectionTitle}>Your Cart</div>
          <div style={styles.cartInfo}>
            {cart.itemCount} item{cart.itemCount !== 1 ? "s" : ""} in cart
            {cart.itemCount > 0 && ` • $${cart.total.toFixed(2)}`}
          </div>
        </div>

        <div style={styles.buttonGroup}>
          <button
            style={{
              ...styles.addToCartButton,
              ...(isPending ? styles.pending : {}),
            }}
            onClick={handleAddToCart}
            disabled={isPending}
          >
            {isPending ? "Adding..." : "Add to Cart"}
          </button>
          <Link to="/shop" style={{ textDecoration: "none" }}>
            <button style={styles.cancelButton}>Back to Shop</button>
          </Link>
        </div>

        {addedMessage && (
          <div
            style={{
              marginTop: "1rem",
              padding: "0.75rem",
              background: "#d1fae5",
              color: "#047857",
              borderRadius: "6px",
              fontSize: "0.875rem",
            }}
          >
            {addedMessage}
          </div>
        )}
      </div>
    </>
  );
}
