import type { ReactNode } from "react";
import type { ErrorBoundaryFallbackProps } from "./types.js";

/**
 * Default error boundary fallback component
 *
 * This is rendered when an error occurs and no custom error boundary
 * is defined in the route tree. Shows a simple "Internal Server Error"
 * message with the error details in development.
 */
export function DefaultErrorFallback({
  error,
}: ErrorBoundaryFallbackProps): ReactNode {
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
      <a
        href="/"
        style={{
          display: "inline-block",
          color: "#2563eb",
          textDecoration: "underline",
        }}
      >
        Go to homepage
      </a>
    </div>
  );
}
