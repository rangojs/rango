"use client";

import { useTransition } from "react";
import { actionSetCtxVar } from "../actions.jsx";

export function ActionCtxSetButton() {
  const [isPending, startTransition] = useTransition();

  return (
    <button
      data-testid="action-ctx-set-btn"
      disabled={isPending}
      onClick={() => startTransition(() => actionSetCtxVar())}
    >
      {isPending ? "Running..." : "Set Ctx Var"}
    </button>
  );
}
