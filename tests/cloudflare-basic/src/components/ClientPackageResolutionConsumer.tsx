"use client";

import { useDeepContext } from "rango-e2e-deep-context-lib/context";
import type { ReactNode } from "react";

export function ClientPackageResolutionConsumer(): ReactNode {
  return (
    <p data-testid="deep-context-value">{useDeepContext() ?? "NOT_FOUND"}</p>
  );
}
