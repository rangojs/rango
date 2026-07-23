"use client";

import { invalidateClientCache } from "@rangojs/router";
import { useTransition } from "react";
import type { ReactNode } from "react";
import { invalidateThroughAction } from "./actions.js";

export function PrefetchInvalidationButton(): ReactNode {
  return (
    <button
      data-testid="prefetch-invalidation-button"
      onClick={() => invalidateClientCache()}
    >
      Invalidate prefetch cache
    </button>
  );
}

export function PrefetchActionInvalidationButton(): ReactNode {
  const [isPending, startTransition] = useTransition();
  return (
    <button
      data-testid="prefetch-action-invalidation-button"
      disabled={isPending}
      onClick={() => startTransition(() => invalidateThroughAction())}
    >
      {isPending ? "Invalidating..." : "Invalidate through action"}
    </button>
  );
}
