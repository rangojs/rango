"use client";

import { Outlet, useLoader } from "rsc-router/client";
import { Link } from "rsc-router/browser";
import { ProductLoader } from "../loaders/product.js";
import type { ReactNode } from "react";

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

// Product modal content - uses loader data
export function ProductModalContent() {
  const product = useLoader(ProductLoader);

  function handleClose() {
    window.history.back();
  }

  async function handleAddToCart() {
    // This would be a server action in a real app
    console.log("Adding to cart:", product.slug);
    alert(`Added ${product.name} to cart!`);
  }

  return (
    <>
      <div style={styles.header}>
        <h2 style={styles.title}>{product.name}</h2>
      </div>
      <div style={styles.body}>
        <div style={styles.price}>${product.price}</div>
        <p style={styles.description}>{product.description}</p>
        <div style={styles.actions}>
          <button style={styles.secondaryButton} onClick={handleAddToCart}>
            Add to Cart
          </button>
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

// Combined modal with wrapper - for backward compatibility
export function ProductModal() {
  return (
    <ModalWrapper>
      <ProductModalContent />
    </ModalWrapper>
  );
}
