"use client";

import { useState, useOptimistic, startTransition } from "react";
import { Outlet, useLoader } from "rsc-router/client";
import { Link } from "rsc-router/browser";
import { ProductLoader } from "../loaders/product.js";
import { ModalRecommendationsLoader } from "../loaders/modal-recommendations.js";
import { ProductCartLoader } from "../loaders/product-cart.js";
import { addToCartWithResult, updateCartQuantity } from "../actions/shop.actions.js";
import { LoadingSpinner } from "./loading.js";

const styles = {
  overlay: {
    position: "fixed" as const,
    inset: 0,
    background: "rgba(0,0,0,0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  },
  modal: {
    background: "white",
    borderRadius: "12px",
    width: "90%",
    maxWidth: "500px",
    maxHeight: "80vh",
    overflow: "auto",
    boxShadow: "0 25px 50px -12px rgba(0,0,0,0.25)",
  },
  header: {
    padding: "1.5rem",
    background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
    borderRadius: "12px 12px 0 0",
  },
  title: {
    margin: 0,
    color: "white",
    fontSize: "1.25rem",
  },
  body: {
    padding: "1.5rem",
  },
  price: {
    fontSize: "1.5rem",
    fontWeight: 700,
    color: "#667eea",
    margin: "1rem 0",
  },
  description: {
    color: "#475569",
    lineHeight: 1.6,
    marginBottom: "1.5rem",
  },
  actions: {
    display: "flex",
    gap: "0.75rem",
  },
  primaryButton: {
    flex: 1,
    background: "#667eea",
    color: "white",
    border: "none",
    padding: "0.75rem 1.5rem",
    borderRadius: "6px",
    cursor: "pointer",
    textDecoration: "none",
    textAlign: "center" as const,
    fontSize: "0.875rem",
    fontWeight: 500,
  },
  secondaryButton: {
    background: "#10b981",
    color: "white",
    border: "none",
    padding: "0.75rem 1rem",
    borderRadius: "6px",
    cursor: "pointer",
    fontSize: "0.875rem",
    fontWeight: 500,
  },
  closeButton: {
    background: "#f1f5f9",
    color: "#64748b",
    border: "none",
    padding: "0.75rem 1rem",
    borderRadius: "6px",
    cursor: "pointer",
    fontSize: "0.875rem",
  },
};

// Reusable modal wrapper - provides overlay and modal chrome
export function ModalWrapper({}: {}) {
  function handleClose() {
    window.history.back();
  }

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === e.currentTarget) {
      handleClose();
    }
  }

  return (
    <div style={styles.overlay} onClick={handleOverlayClick}>
      <div style={styles.modal}>
        <Outlet />
      </div>
    </div>
  );
}

// Quantity control styles
const quantityStyles = {
  container: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    background: "#f1f5f9",
    borderRadius: "8px",
    padding: "0.25rem",
  },
  button: {
    width: "32px",
    height: "32px",
    border: "none",
    borderRadius: "6px",
    cursor: "pointer",
    fontSize: "1.25rem",
    fontWeight: 600,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "all 0.15s ease",
  },
  decrementButton: {
    background: "#ef4444",
    color: "white",
  },
  incrementButton: {
    background: "#10b981",
    color: "white",
  },
  quantity: {
    minWidth: "2.5rem",
    textAlign: "center" as const,
    fontWeight: 600,
    fontSize: "1rem",
    color: "#1e293b",
  },
};

// Product modal content - uses loader data
export function ProductModalContent() {
  const product = useLoader(ProductLoader);
  const recommendations = useLoader(ModalRecommendationsLoader);
  const productCart = useLoader(ProductCartLoader);
  console.log("ProductModalContent loader", { productCart });

  // Optimistic quantity state - updates immediately before server confirms
  const [optimisticQuantity, setOptimisticQuantity] = useOptimistic(
    productCart.quantity,
    (_current, newQuantity: number) => newQuantity
  );

  const [actionResult, setActionResult] = useState<{
    success: boolean;
    message: string;
    cart: { totalItems: number };
  } | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  function handleClose() {
    window.history.back();
  }

  async function handleAddToCart() {
    setIsLoading(true);
    try {
      const result = await addToCartWithResult(product.slug, 1);
      setActionResult(result);
    } catch (error) {
      console.error("Failed to add to cart:", error);
    } finally {
      setIsLoading(false);
    }
  }

  function handleQuantityChange(delta: number) {
    const newQuantity = Math.max(0, optimisticQuantity + delta);

    startTransition(async () => {
      // Optimistically update UI immediately
      setOptimisticQuantity(newQuantity);

      // Then perform the actual server action
      await updateCartQuantity(product.slug, delta);
    });
  }

  return (
    <>
      <div style={styles.header}>
        Intercepted
        <h2 style={styles.title}>{product.name}</h2>
      </div>
      <div style={styles.body}>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <div style={styles.price}>${product.price}</div>
        </div>
        <p style={styles.description}>{product.description}</p>

        {/* Quantity Control */}
        <div style={{ marginBottom: "1rem" }}>
          <div
            style={{
              fontSize: "0.875rem",
              color: "#64748b",
              marginBottom: "0.5rem",
            }}
          >
            Quantity in cart:
          </div>
          {optimisticQuantity > 0 ? (
            <div style={quantityStyles.container}>
              <button
                style={{
                  ...quantityStyles.button,
                  ...quantityStyles.decrementButton,
                }}
                onClick={() => handleQuantityChange(-1)}
                title={optimisticQuantity === 1 ? "Remove from cart" : "Decrease quantity"}
              >
                {optimisticQuantity === 1 ? "x" : "-"}
              </button>
              <span style={quantityStyles.quantity}>{optimisticQuantity}</span>
              <button
                style={{
                  ...quantityStyles.button,
                  ...quantityStyles.incrementButton,
                }}
                onClick={() => handleQuantityChange(1)}
                title="Increase quantity"
              >
                +
              </button>
            </div>
          ) : (
            <button
              style={{
                ...styles.secondaryButton,
                opacity: isLoading ? 0.7 : 1,
              }}
              onClick={() => handleQuantityChange(1)}
              disabled={isLoading}
            >
              Add to Cart
            </button>
          )}
        </div>

        <LoadingSpinner />
        {actionResult && (
          <div
            style={{
              padding: "0.75rem",
              marginBottom: "1rem",
              background: actionResult.success ? "#d1fae5" : "#fee2e2",
              borderRadius: "6px",
              color: actionResult.success ? "#065f46" : "#991b1b",
            }}
          >
            {actionResult.message} (Total: {actionResult.cart.totalItems} items)
          </div>
        )}

        <div style={styles.actions}>
          <Link
            to={`/shop/product/${product.slug}`}
            style={styles.primaryButton}
          >
            View Full Details
          </Link>
          <button style={styles.closeButton} onClick={handleClose}>
            Close
          </button>
        </div>

        {/* Recommendations section - streams after action revalidation */}
        <div
          style={{
            marginTop: "1.5rem",
            paddingTop: "1rem",
            borderTop: "1px solid #e2e8f0",
          }}
        >
          <h3
            style={{
              fontSize: "0.875rem",
              color: "#64748b",
              marginBottom: "0.75rem",
            }}
          >
            You might also like (loaded at {recommendations.loadedAt})
          </h3>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            {recommendations.recommendations.map((rec) => (
              <Link
                key={rec.id}
                to={`/shop/product/${rec.slug}`}
                style={{
                  padding: "0.5rem 0.75rem",
                  background: "#f1f5f9",
                  borderRadius: "6px",
                  fontSize: "0.75rem",
                  color: "#475569",
                  textDecoration: "none",
                }}
              >
                {rec.name} - ${rec.price}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

// Skeleton for loading state - just the content, no wrapper
const skeletonStyle = {
  background: "linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%)",
  backgroundSize: "200% 100%",
  animation: "shimmer 1.5s infinite",
  borderRadius: "4px",
};

export function ProductModalContentSkeleton() {
  return (
    <>
      <div style={styles.header}>
        <div
          style={{
            ...skeletonStyle,
            height: "24px",
            width: "60%",
            background: "rgba(255,255,255,0.3)",
          }}
        />
      </div>
      <div style={styles.body}>
        <div
          style={{
            ...skeletonStyle,
            height: "32px",
            width: "40%",
            marginBottom: "1rem",
          }}
        />
        <div
          style={{
            ...skeletonStyle,
            height: "16px",
            width: "100%",
            marginBottom: "0.5rem",
          }}
        />
        <div
          style={{
            ...skeletonStyle,
            height: "16px",
            width: "90%",
            marginBottom: "0.5rem",
          }}
        />
        <div
          style={{
            ...skeletonStyle,
            height: "16px",
            width: "75%",
            marginBottom: "1.5rem",
          }}
        />
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <div style={{ ...skeletonStyle, height: "44px", width: "100px" }} />
          <div style={{ ...skeletonStyle, height: "44px", flex: 1 }} />
          <div style={{ ...skeletonStyle, height: "44px", width: "60px" }} />
        </div>
      </div>
    </>
  );
}
