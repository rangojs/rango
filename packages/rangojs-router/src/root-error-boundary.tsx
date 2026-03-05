"use client";

import { Component, useState, type ReactNode } from "react";
import type { ClientErrorBoundaryFallbackProps } from "./types.js";

/**
 * Check if an error is a network-related error
 */
function isNetworkError(error: Error): boolean {
  return error.name === "NetworkError";
}

/**
 * Network error fallback UI with retry functionality
 * Shows a connection-specific message and allows retrying via page refresh
 */
function NetworkErrorFallback({
  error,
  reset,
}: ClientErrorBoundaryFallbackProps): ReactNode {
  const [isRetrying, setIsRetrying] = useState(false);

  const handleRetry = (): void => {
    setIsRetrying(true);
    // Refresh the page to retry the request
    window.location.reload();
  };

  return (
    <div
      style={{
        fontFamily: "system-ui, -apple-system, sans-serif",
        padding: "2rem",
        maxWidth: "600px",
        margin: "2rem auto",
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontSize: "3rem",
          marginBottom: "1rem",
        }}
      >
        {/* Simple cloud with x icon using CSS */}
        <span style={{ color: "#9ca3af" }}>&#9729;</span>
      </div>
      <h1
        style={{
          color: "#374151",
          fontSize: "1.5rem",
          marginBottom: "0.5rem",
        }}
      >
        Connection Error
      </h1>
      <p
        style={{
          color: "#6b7280",
          marginBottom: "1.5rem",
        }}
      >
        {error.message ||
          "Unable to connect to the server. Please check your internet connection."}
      </p>
      <div style={{ display: "flex", gap: "1rem", justifyContent: "center" }}>
        <button
          type="button"
          onClick={handleRetry}
          disabled={isRetrying}
          style={{
            padding: "0.75rem 1.5rem",
            backgroundColor: isRetrying ? "#9ca3af" : "#2563eb",
            color: "white",
            border: "none",
            borderRadius: "0.375rem",
            cursor: isRetrying ? "not-allowed" : "pointer",
            fontSize: "1rem",
            fontWeight: 500,
          }}
        >
          {isRetrying ? "Retrying..." : "Retry"}
        </button>
        <button
          type="button"
          onClick={() => window.history.back()}
          style={{
            padding: "0.75rem 1.5rem",
            backgroundColor: "transparent",
            color: "#6b7280",
            border: "1px solid #d1d5db",
            borderRadius: "0.375rem",
            cursor: "pointer",
            fontSize: "1rem",
          }}
        >
          Go Back
        </button>
      </div>
    </div>
  );
}

/**
 * Default fallback UI for root error boundary
 * This is shown when an unhandled error bubbles up to the root
 */
function RootErrorFallback({
  error,
  reset,
}: ClientErrorBoundaryFallbackProps): ReactNode {
  const isDev = process.env.NODE_ENV !== "production";

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
      {isDev && (
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
      )}
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
    console.error(
      "[RootErrorBoundary] Unhandled error caught:",
      error,
      errorInfo,
    );
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
      const errorInfo = {
        message: this.state.error.message,
        name: this.state.error.name,
        stack: this.state.error.stack,
        cause: this.state.error.cause,
        segmentId: "root",
        segmentType: "route" as const,
      };

      // Use specialized fallback for network errors
      if (isNetworkError(this.state.error)) {
        return <NetworkErrorFallback error={errorInfo} reset={this.reset} />;
      }

      return <RootErrorFallback error={errorInfo} reset={this.reset} />;
    }

    return this.props.children;
  }
}
