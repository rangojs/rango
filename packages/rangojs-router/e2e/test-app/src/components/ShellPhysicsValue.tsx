"use client";

import { Suspense, use } from "react";

function Inner({ promise }: { promise: Promise<string> }) {
  return <span data-testid="shell-physics-value">{use(promise)}</span>;
}

/**
 * Handler-promise consumer: a handler-created promise handed over as a prop
 * and use()'d under this component's OWN <Suspense>. It is handler output:
 * the PPR capture waits for it (~250ms) and bakes the value into the prelude,
 * and a HIT replays it. A per-request value belongs in a live loader instead.
 */
export function ShellPhysicsValue({ promise }: { promise: Promise<string> }) {
  return (
    <Suspense
      fallback={
        <span data-testid="shell-physics-fallback">physics pending...</span>
      }
    >
      <Inner promise={promise} />
    </Suspense>
  );
}
