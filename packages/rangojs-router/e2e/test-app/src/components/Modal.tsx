"use client";

import { ReactNode } from "react";

interface ModalProps {
  children: ReactNode;
  testId: string;
}

/**
 * Modal wrapper for intercept routes
 */
export function Modal({ children, testId }: ModalProps) {
  function handleClose() {
    window.history.back();
  }

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === e.currentTarget) {
      handleClose();
    }
  }

  return (
    <div
      data-testid={testId}
      onClick={handleOverlayClick}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        data-testid={`${testId}-content`}
        style={{
          background: "white",
          borderRadius: "8px",
          padding: "24px",
          maxWidth: "500px",
          width: "90%",
          maxHeight: "80vh",
          overflow: "auto",
        }}
      >
        {children}
        <button
          onClick={handleClose}
          data-testid={`${testId}-close`}
          style={{
            marginTop: "16px",
            padding: "8px 16px",
            background: "#ccc",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
          }}
        >
          Close
        </button>
      </div>
    </div>
  );
}
