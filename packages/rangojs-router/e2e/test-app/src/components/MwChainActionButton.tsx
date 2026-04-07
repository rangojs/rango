"use client";

import { useTransition } from "react";
import { mwChainAction } from "../actions.jsx";

export function MwChainActionButton({
  testId = "chain-action-btn",
}: {
  testId?: string;
}) {
  const [isPending, startTransition] = useTransition();

  return (
    <button
      data-testid={testId}
      disabled={isPending}
      onClick={() => startTransition(() => mwChainAction())}
    >
      {isPending ? "Running..." : "Run Chain Action"}
    </button>
  );
}
