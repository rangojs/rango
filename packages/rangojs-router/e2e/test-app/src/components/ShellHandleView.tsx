"use client";

import { Suspense, use } from "react";
import { useHandle } from "@rangojs/router/client";
import { ShellHandles } from "../urls/shell-cache.defs.js";

function Nested({ promise }: { promise: Promise<string> }) {
  return <span data-testid="shell-handle-nested">{use(promise)}</span>;
}

function NestedFast({ promise }: { promise: Promise<string> }) {
  return <span data-testid="shell-handle-nested-fast">{use(promise)}</span>;
}

/**
 * Handles-contract consumer ("nesting = liveness"):
 *   - the BAKED item was pushed as a TOP-LEVEL promise; the router awaited it
 *     before the payload's handles row emitted (and the capture gate held for the
 *     same await), so its value renders synchronously — shell material;
 *   - the NESTED item is a container whose `pending` promise passed through
 *     verbatim (shallow resolution never bakes nested promises); this component
 *     must Suspense it, and under capture that boundary postpones — a hole.
 */
export function ShellHandleView() {
  const items = useHandle(ShellHandles) ?? [];
  const baked = items.find((i) => i.kind === "baked");
  const nested = items.find((i) => i.kind === "nested");
  const nestedFast = items.find((i) => i.kind === "nested-fast");
  return (
    <div data-testid="shell-handle-view">
      <span data-testid="shell-handle-baked">{baked?.value ?? "none"}</span>
      {nestedFast?.pending ? (
        <Suspense
          fallback={
            <span data-testid="shell-handle-nested-fast-fallback">
              nested-fast pending...
            </span>
          }
        >
          <NestedFast promise={nestedFast.pending} />
        </Suspense>
      ) : null}
      {nested?.pending ? (
        <Suspense
          fallback={
            <span data-testid="shell-handle-nested-fallback">
              nested pending...
            </span>
          }
        >
          <Nested promise={nested.pending} />
        </Suspense>
      ) : null}
    </div>
  );
}
