"use client";

import {
  ErrorBoundary,
  useClientCache,
  useRouter,
} from "@rangojs/router/client";
import type { ClientErrorBoundaryFallbackProps } from "@rangojs/router";
import type { ReactNode } from "react";

// Wrapper component that uses hooks - called as a component, not a function
function KanbanClientErrorFallback({
  error,
  reset,
}: ClientErrorBoundaryFallbackProps) {
  const { clear } = useClientCache();
  const router = useRouter();

  function handleReload() {
    clear();
    reset();
    router.push("/kanban");
  }

  return (
    <div
      style={{
        padding: "2rem",
        background: "linear-gradient(135deg, #fef2f2 0%, #fee2e2 100%)",
        borderRadius: "8px",
        border: "1px solid #fecaca",
        margin: "1rem",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          marginBottom: "1rem",
        }}
      >
        <span style={{ fontSize: "1.5rem" }}>⚠️</span>
        <h2 style={{ margin: 0, color: "#991b1b", fontSize: "1.25rem" }}>
          Board Error
        </h2>
      </div>
      <p style={{ color: "#7f1d1d", marginBottom: "1rem" }}>
        Something went wrong with the Kanban board.
      </p>
      <div
        style={{
          background: "white",
          padding: "1rem",
          borderRadius: "4px",
          marginBottom: "1rem",
        }}
      >
        <p
          style={{
            margin: 0,
            fontFamily: "monospace",
            fontSize: "0.875rem",
            color: "#dc2626",
          }}
        >
          {error.name}: {error.message}
        </p>
      </div>
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button
          type="button"
          onClick={reset}
          style={{
            padding: "0.5rem 1rem",
            background: "#0ea5e9",
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
          }}
        >
          Try Again
        </button>
        <button
          type="button"
          onClick={handleReload}
          style={{
            padding: "0.5rem 1rem",
            background: "#6b7280",
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
          }}
        >
          Reload Board
        </button>
      </div>
    </div>
  );
}

export function KanbanErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary fallback={KanbanClientErrorFallback}>
      {children}
    </ErrorBoundary>
  );
}
