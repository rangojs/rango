"use client";

import { Component, useEffect, useState, type ReactNode } from "react";
import type { ClientErrorBoundaryFallbackProps } from "./types.js";

/**
 * Default fallback UI for root error boundary
 * This is shown when an unhandled error bubbles up to the root
 */
function RootErrorFallback({ error, reset }: ClientErrorBoundaryFallbackProps): ReactNode {
  return (
    <div
      style={{
        fontFamily: "system-ui, -apple-system, sans-serif",
        padding: "2rem",
        maxWidth: "600px",
        margin: "2rem auto",
      }}
    >
      <h1
        style={{
          color: "#dc2626",
          fontSize: "1.5rem",
          marginBottom: "1rem",
        }}
      >
        Internal Server Error
      </h1>
      <p
        style={{
          color: "#374151",
          marginBottom: "1rem",
        }}
      >
        An unexpected error occurred while processing your request.
      </p>
      <div
        style={{
          background: "#fef2f2",
          border: "1px solid #fecaca",
          borderRadius: "0.5rem",
          padding: "1rem",
          marginBottom: "1rem",
        }}
      >
        <p
          style={{
            fontWeight: 600,
            color: "#991b1b",
            marginBottom: "0.5rem",
          }}
        >
          {error.name}: {error.message}
        </p>
        {error.stack && (
          <pre
            style={{
              fontSize: "0.75rem",
              color: "#6b7280",
              overflow: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {error.stack}
          </pre>
        )}
      </div>
      <div style={{ display: "flex", gap: "1rem" }}>
        <button
          type="button"
          onClick={reset}
          style={{
            padding: "0.5rem 1rem",
            backgroundColor: "#2563eb",
            color: "white",
            border: "none",
            borderRadius: "0.25rem",
            cursor: "pointer",
          }}
        >
          Try Again
        </button>
        <a
          href="/"
          style={{
            display: "inline-block",
            padding: "0.5rem 1rem",
            color: "#2563eb",
            textDecoration: "underline",
          }}
        >
          Go to homepage
        </a>
      </div>
    </div>
  );
}

interface RootErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Root error boundary component
 *
 * Wraps the entire segment tree to catch any unhandled errors that bubble up.
 * This prevents the entire app from crashing with a white screen.
 *
 * This is a client component with an inline fallback to avoid the
 * "Functions cannot be passed to Client Components" RSC error.
 */
export class RootErrorBoundary extends Component<
  { children: ReactNode },
  RootErrorBoundaryState
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): RootErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidMount(): void {
    // Listen for popstate (back/forward navigation) to reset error state
    window.addEventListener("popstate", this.handlePopState);
  }

  componentWillUnmount(): void {
    window.removeEventListener("popstate", this.handlePopState);
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error("[RootErrorBoundary] Unhandled error caught:", error, errorInfo);
  }

  componentDidUpdate(prevProps: { children: ReactNode }): void {
    // Reset error state when children change (e.g., navigation)
    // This allows the app to recover after navigation away from an errored route
    if (this.state.hasError && prevProps.children !== this.props.children) {
      this.setState({ hasError: false, error: null });
    }
  }

  handlePopState = (): void => {
    // Reset error state on back/forward navigation
    if (this.state.hasError) {
      this.setState({ hasError: false, error: null });
    }
  };

  reset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (this.state.hasError && this.state.error) {
      return (
        <RootErrorFallback
          error={{
            message: this.state.error.message,
            name: this.state.error.name,
            stack: this.state.error.stack,
            cause: this.state.error.cause,
            segmentId: "root",
            segmentType: "route",
          }}
          reset={this.reset}
        />
      );
    }

    return this.props.children;
  }
}
