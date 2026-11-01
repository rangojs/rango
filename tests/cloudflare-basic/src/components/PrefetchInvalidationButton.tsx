"use client";

import { invalidateClientCache } from "@rangojs/router";
import { useTransition } from "react";
import type { ReactNode } from "react";
import { logoutAction } from "../actions/client-cache.js";

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

/** A server action whose body calls invalidateClientCache() (the server seat). */
export function PrefetchActionInvalidationButton(): ReactNode {
  const [isPending, startTransition] = useTransition();
  return (
    <button
      data-testid="prefetch-action-invalidation-button"
      disabled={isPending}
      onClick={() =>
        startTransition(async () => {
          await logoutAction();
        })
      }
    >
      {isPending ? "Invalidating..." : "Invalidate through action"}
    </button>
  );
}
