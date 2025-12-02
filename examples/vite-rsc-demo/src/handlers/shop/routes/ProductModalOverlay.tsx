"use client";

import { useRef, useEffect } from "react";
import { Outlet } from "rsc-router/client";

const styles = {
  overlay: {
    position: "fixed" as const,
    inset: 0,
    background: "rgba(0,0,0,0.5)",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "center",
    paddingTop: "5vh",
    zIndex: 1000,
    overflow: "auto",
  },
  modal: {
    position: "relative" as const,
    background: "white",
    borderRadius: "8px",
    width: "calc(100% - 2rem)",
    maxWidth: "900px",
    maxHeight: "90vh",
    overflow: "auto",
    boxShadow: "0 25px 50px -12px rgba(0,0,0,0.25)",
    marginBottom: "2rem",
  },
  closeButton: {
    position: "absolute" as const,
    top: "1rem",
    right: "1rem",
    background: "rgba(0,0,0,0.5)",
    border: "none",
    fontSize: "1.5rem",
    cursor: "pointer",
    color: "white",
    padding: "0.25rem 0.75rem",
    lineHeight: 1,
    borderRadius: "4px",
    zIndex: 1,
  },
};

// Modal layout that wraps intercept content via <Outlet />
// Simple implementation without Radix to avoid layout shifts from aria-hidden
export function ProductModalOverlay() {
  const isClosing = useRef(false);

  // Handle escape key
  useEffect(() => {
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") handleClose();
    }
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, []);

  function handleClose() {
    if (isClosing.current) return;
    isClosing.current = true;
    window.history.back();
  }

  return (
    <div style={styles.overlay} onClick={handleClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <button style={styles.closeButton} onClick={handleClose}>
          ×
        </button>
        <Outlet />
      </div>
    </div>
  );
}
