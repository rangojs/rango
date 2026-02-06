"use client";

/**
 * Component that intentionally causes hydration mismatch for testing.
 * Uses Date.now() which will always differ between server and client render.
 */
export function HydrationMismatch({ testId }: { testId: string }) {
  // Date.now() is guaranteed to be different between server and client
  // This should trigger a hydration mismatch warning
  return <span data-testid={testId}>timestamp-{Date.now()}</span>;
}
