"use client";

import { invalidateClientCache } from "@rangojs/router";
import { useState, useTransition } from "react";
import type { ReactNode } from "react";
import { invalidateThroughAction, plainThroughAction } from "./actions.js";

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

/** Runs the plain action and shows the count it wrote. */
export function PrefetchActionPlainButton(): ReactNode {
  const [isPending, startTransition] = useTransition();
  const [written, setWritten] = useState<number | null>(null);
  return (
    <>
      <button
        data-testid="prefetch-action-plain-button"
        disabled={isPending}
        onClick={() =>
          startTransition(async () => {
            setWritten(await plainThroughAction());
          })
        }
      >
        {isPending ? "Running..." : "Run plain action"}
      </button>
      <output data-testid="prefetch-action-plain-written">{written}</output>
    </>
  );
}
