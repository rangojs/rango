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
 * Handle-push consumer:
 *   - the BAKED item was pushed as a TOP-LEVEL promise; the router awaited it
 *     before the payload's handles row emitted, so its value renders
 *     synchronously;
 *   - the NESTED items are containers whose `pending` promise passed through
 *     verbatim; this component Suspenses them. They were pushed by a handler,
 *     so the PPR capture waits for them and bakes their values too (a DSL
 *     loader's nested push would stay live).
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
