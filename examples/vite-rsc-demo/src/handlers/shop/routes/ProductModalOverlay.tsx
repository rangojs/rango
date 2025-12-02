"use client";

import { useEffect } from "react";
import { Outlet } from "rsc-router/client";

const styles = {
  overlay: {
    position: "fixed" as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: "rgba(0,0,0,0.5)",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "center",
    paddingTop: "5vh",
    zIndex: 1000,
    overflow: "auto",
  },
  modal: {
    background: "white",
    borderRadius: "8px",
    width: "100%",
    maxWidth: "900px",
    maxHeight: "90vh",
    overflow: "auto",
    boxShadow: "0 25px 50px -12px rgba(0,0,0,0.25)",
    margin: "0 1rem 2rem",
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
    zIndex: 1001,
  },
};

// Modal layout that wraps intercept content via <Outlet />
// This is used with layout() inside intercept() to separate modal chrome from content
export function ProductModalOverlay() {
  // Lock body scroll when modal is open
  useEffect(() => {
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, []);

  function handleClose(e?: React.MouseEvent) {
    e?.stopPropagation();
    window.history.back();
  }

  return (
    <div style={styles.overlay} onClick={handleClose}>
      <button style={styles.closeButton} onClick={handleClose}>
        ×
      </button>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <Outlet />
      </div>
    </div>
  );
}
