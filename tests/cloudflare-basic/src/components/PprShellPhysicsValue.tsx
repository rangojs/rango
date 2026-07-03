"use client";

import { Suspense, use } from "react";

function Inner({ promise }: { promise: Promise<string> }) {
  return <span data-testid="ppr-physics-value">{use(promise)}</span>;
}

/**
 * Physics-hole consumer: a handler-created pending promise handed over as a prop
 * and use()'d under this component's OWN <Suspense>. During shell capture the
 * promise (~250ms of real latency) cannot win the task-quantized quiet window, so
 * the boundary postpones — the prelude freezes the fallback and the resume
 * streams the value. Deterministic by latency class, not by registration.
 */
export function PprShellPhysicsValue({
  promise,
}: {
  promise: Promise<string>;
}) {
  return (
    <Suspense
      fallback={
        <span data-testid="ppr-physics-fallback">physics pending...</span>
      }
    >
      <Inner promise={promise} />
    </Suspense>
  );
}
