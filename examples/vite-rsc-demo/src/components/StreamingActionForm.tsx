"use client";

import { use, useActionState, Suspense, startTransition } from "react";
import { StreamingAction } from "../actions/test.actions";

/**
 * Streaming Action Form - demonstrates Promise streaming with Suspense
 *
 * The action returns a Promise that streams to the client.
 * Suspense boundary waits for it to resolve.
 */
export function StreamingActionForm({
  productId,
  action,
  children,
}: {
  productId: string;
  action: (productId: string, quantity: number) => Promise<any>;
  children?: React.ReactNode;
}) {
  const [state, formAction, isPending] = useActionState(
    async (_prevState, formData) => {
      try {
        console.log("StreamingActionForm data set", { isPending, state });
        const result = await StreamingAction({ teststestse: true });
        console.log("[StreamingAction] Action result:", result);
        return result;
      } catch (error) {
        console.error("[StreamingAction] Action error:", error);
        return { success: false, error: String(error) };
      }
    },
    {
      promise: null,
    }
  );
  console.log("StreamingActionForm isPending", { isPending, state });

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
          {isPending ? "Processing..." : <>{children}</>}
        </button>
      </form>

      {state.promise && (
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

  return promise;
}
