"use client";

import { useActionState } from "react";
import { alsScopeAction } from "../actions.js";

export function AlsScopeActionButton() {
  const [, formAction, isPending] = useActionState(async () => {
    await alsScopeAction();
    return true;
  }, false);

  return (
    <form action={formAction}>
      <button type="submit" data-testid="als-action-btn" disabled={isPending}>
        {isPending ? "Running..." : "Run ALS Action"}
      </button>
    </form>
  );
}
