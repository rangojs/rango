"use client";

import { useState } from "react";

/**
 * Client component that throws an error when triggered.
 * Used to test client-side error boundary behavior.
 */
export function ClientErrorThrower({ testId }: { testId: string }) {
  const [shouldThrow, setShouldThrow] = useState(false);

  if (shouldThrow) {
    throw new Error("Client-side error: This error was thrown in a client component");
  }

  return (
    <div data-testid={testId}>
      <p data-testid={`${testId}-info`}>Click the button to trigger a client-side error.</p>
      <button
        type="button"
        onClick={() => setShouldThrow(true)}
        data-testid={`${testId}-trigger`}
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

/**
 * Client component that throws during initial render.
 * Used to test hydration error boundary behavior.
 */
export function ClientErrorOnMount({ testId }: { testId: string }) {
  // Always throw on render
  throw new Error("Client mount error: This error was thrown during component mount");

  // This code is unreachable but TypeScript needs a return
  return <div data-testid={testId}>This should never render</div>;
}
