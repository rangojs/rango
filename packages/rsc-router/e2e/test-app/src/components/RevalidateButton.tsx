"use client";

import { useActionState } from "react";
import { triggerRevalidation } from "../actions.jsx";

interface RevalidateButtonProps {
  testId: string;
}

export function RevalidateButton({ testId }: RevalidateButtonProps) {
  const [state, formAction, isPending] = useActionState(async () => {
    return await triggerRevalidation();
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
            background: isPending ? "#ccc" : "#4CAF50",
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: isPending ? "wait" : "pointer",
          }}
        >
          {isPending ? "Triggering..." : "Trigger Revalidation"}
        </button>
      </form>
      {state && (
        <div data-testid={`${testId}-result`} style={{ marginTop: "8px" }}>
          Revalidated at: {state.timestamp}
        </div>
      )}
    </div>
  );
}
