"use client";

import { useActionState, use, Suspense, ReactNode } from "react";
import { StreamingAction } from "../actions.jsx";

interface StreamingActionButtonProps {
  productId: string;
  testId: string;
}

function StreamingResult({ promise }: { promise: Promise<ReactNode> }) {
  const result = use(promise);
  return <>{result}</>;
}

/**
 * Button for streaming action - takes 3 seconds
 */
export function StreamingActionButton({
  productId,
  testId,
}: StreamingActionButtonProps) {
  const [state, formAction, isPending] = useActionState(async () => {
    const formData = new FormData();
    formData.set("productId", productId);
    return await StreamingAction(formData);
  }, null);

  return (
    <div>
      <form action={formAction}>
        <button
          type="submit"
          disabled={isPending}
          data-testid={testId}
          style={{
            padding: "8px 16px",
            background: isPending ? "#ccc" : "#ff9800",
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: isPending ? "wait" : "pointer",
          }}
        >
          {isPending ? "Processing..." : "Streaming Action"}
        </button>
      </form>
      {state && (
        <Suspense fallback={<div data-testid={`${testId}-loading`}>Streaming...</div>}>
          <div data-testid={`${testId}-result`}>
            <StreamingResult promise={state.promise} />
          </div>
        </Suspense>
      )}
    </div>
  );
}

/**
 * Shows action status using useAction hook
 */
export function ActionStatus({ testId }: { testId: string }) {
  return <div data-testid={testId}>Action status: idle</div>;
}
