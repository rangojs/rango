"use client";

import { useActionState } from "react";
import { incrementHoleAction } from "../actions/shell-cache-action.js";

// 10(d): an action on the DSL-attached PPR route. A POST is non-GET, so the
// route-middleware pass (the shell-cache middleware attached via middleware())
// bypasses shell logic entirely — no flags armed, the action response is untouched.
export function ShellDslActionButton() {
  const [state, formAction, isPending] = useActionState(
    async () => await incrementHoleAction(),
    null,
  );
  return (
    <form action={formAction} data-testid="shell-dsl-action-form">
      <button
        type="submit"
        disabled={isPending}
        data-testid="shell-dsl-action-btn"
      >
        DSL Action
      </button>
      {state && (
        <span data-testid="shell-dsl-action-result">
          applied: {state.count}
        </span>
      )}
    </form>
  );
}
