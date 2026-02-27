"use client";

import { useActionState } from "react";
import { interleaveTestAction } from "../actions.jsx";

export function InterleaveActionButton() {
  const [state, formAction, isPending] = useActionState(async () => {
    return await interleaveTestAction("test-input");
  }, null);

  return (
    <div>
      <form action={formAction}>
        <button
          type="submit"
          disabled={isPending}
          data-testid="interleave-action-btn"
        >
          {isPending ? "Running..." : "Run Action"}
        </button>
      </form>
      {state && (
        <div data-testid="interleave-action-result">
          <span data-testid="interleave-action-result-text">
            {state.result}
          </span>
          <span data-testid="interleave-action-result-ts">{state.ts}</span>
        </div>
      )}
    </div>
  );
}
