"use client";

import { useTransition } from "react";
import { actionKeepCache, actionKeepThenInvalidate } from "../actions.jsx";

export function ActionKeepCacheButton() {
  const [isPending, startTransition] = useTransition();

  return (
    <button
      data-testid="action-keep-cache-btn"
      disabled={isPending}
      onClick={() => startTransition(() => actionKeepCache())}
    >
      {isPending ? "Keeping..." : "Keep Cache via Action"}
    </button>
  );
}

export function ActionKeepThenInvalidateButton() {
  const [isPending, startTransition] = useTransition();

  return (
    <button
      data-testid="action-keep-then-invalidate-btn"
      disabled={isPending}
      onClick={() => startTransition(() => actionKeepThenInvalidate())}
    >
      {isPending ? "Working..." : "Keep + Invalidate via Action"}
    </button>
  );
}
