"use client";

import { use, useActionState, Suspense } from "react";

type ActionState = {
  promise?: Promise<any>;
  result?: any;
  error?: string;
} | null;

/**
 * Streaming Action Form - demonstrates Promise streaming with Suspense
 *
 * The action returns a Promise that streams to the client.
 * Suspense boundary waits for it to resolve.
 */
export function StreamingActionForm({
  productId,
  action,
}: {
  productId: string;
  action: (productId: string, quantity: number) => Promise<any>;
}) {
  const [state, formAction, isPending] = useActionState<ActionState, FormData>(
    async (_prevState, _formData) => {
      console.log("[StreamingActionForm] Starting action...");

      // Call the action - it returns a Promise
      const promise = action(productId, 1);

      console.log(
        "[StreamingActionForm] Action returned Promise, storing for Suspense"
      );

      // Return the Promise - Suspense will wait for it
      return { promise };
    },
    null
  );

  return (
    <div>
      <form action={formAction}>
        <button
          type="submit"
          disabled={isPending}
          style={{
            background: isPending ? "#ccc" : "#ff6b6b",
            color: "white",
            border: "none",
            padding: "0.75rem 1.5rem",
            borderRadius: "4px",
            fontSize: "1rem",
            cursor: isPending ? "not-allowed" : "pointer",
            marginTop: "1rem",
          }}
        >
          {isPending ? "Processing..." : "Add to Cart (Streaming)"}
        </button>
      </form>

      {state?.promise && (
        <div
          style={{
            marginTop: "1rem",
            padding: "1rem",
            background: "#fff3cd",
            border: "1px solid '#ffc107'",
            borderRadius: "4px",
          }}
        >
          <Suspense
            fallback={
              <div>
                <h4 style={{ margin: "0 0 0.5rem 0" }}>⏳ Streaming...</h4>
                <p style={{ margin: 0, fontSize: "0.9rem" }}>
                  Waiting for server to complete slow operation (3 seconds)...
                </p>
                <div
                  style={{
                    marginTop: "0.5rem",
                    width: "100%",
                    height: "4px",
                    background: "#e0e0e0",
                    borderRadius: "2px",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: "100%",
                      height: "100%",
                      background: "#ffc107",
                      animation: "slide 1.5s ease-in-out infinite",
                    }}
                  />
                </div>
              </div>
            }
          >
            <PromiseResolver promise={state.promise} />
          </Suspense>
        </div>
      )}
    </div>
  );
}

/**
 * Component that uses() a Promise - triggers Suspense
 */
function PromiseResolver({ promise }: { promise: Promise<any> }) {
  // use() hook suspends until Promise resolves
  const result = use(promise);

  console.log("[PromiseResolver] Promise resolved:", result);

  return (
    <div
      style={{ background: "#d4edda", padding: "1rem", borderRadius: "4px" }}
    >
      <h4 style={{ margin: "0 0 0.5rem 0" }}>✅ Completed!</h4>
      <p style={{ margin: "0 0 0.5rem 0" }}>
        <strong>{result.message}</strong>
      </p>
      <ul style={{ margin: 0, paddingLeft: "1.5rem", fontSize: "0.9rem" }}>
        <li>Completed at: {new Date(result.timestamp).toLocaleTimeString()}</li>
        <li>Product: {result.cart.productId}</li>
        <li>Quantity: {result.cart.quantity}</li>
        <li>Total items: {result.cart.totalItems}</li>
      </ul>
    </div>
  );
}
