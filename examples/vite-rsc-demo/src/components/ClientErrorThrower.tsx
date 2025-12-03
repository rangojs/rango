"use client";

import { useState } from "react";

/**
 * Client component that throws an error when a button is clicked.
 * Used to test the client-side error boundary behavior.
 */
export function ClientErrorThrower() {
  const [shouldThrow, setShouldThrow] = useState(false);

  if (shouldThrow) {
    throw new Error("Client-side error: This error was thrown in a client component");
  }

  return (
    <div style={{ padding: "20px", backgroundColor: "#f0f8ff", border: "1px solid #4a90d9" }}>
      <h2>Client Error Test</h2>
      <p>Click the button below to trigger a client-side error.</p>
      <p>This error is caught by the client-side ErrorBoundary.</p>
      <button
        type="button"
        onClick={() => setShouldThrow(true)}
        style={{
          padding: "10px 20px",
          backgroundColor: "#dc3545",
          color: "white",
          border: "none",
          borderRadius: "4px",
          cursor: "pointer",
        }}
      >
        Throw Client Error
      </button>
    </div>
  );
}
