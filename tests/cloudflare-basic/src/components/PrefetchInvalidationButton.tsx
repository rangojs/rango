"use client";

import { invalidateClientCache } from "@rangojs/router";
import type { ReactNode } from "react";

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
