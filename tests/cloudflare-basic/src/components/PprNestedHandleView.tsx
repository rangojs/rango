"use client";

import { Suspense, use } from "react";
import { useHandle } from "@rangojs/router/client";
import { PprNestedHandle } from "../loaders/ppr-shell.js";

function Value({ promise }: { promise: Promise<string> }) {
  return <span data-testid="ppr-nested-handle-value">{use(promise)}</span>;
}

/**
 * Consumer of a handler handle push that carries a nested promise
 * (PprShellLayout). The push is handler output, so the PPR capture waits for
 * the nested promise and bakes its value into the prelude.
 */
export function PprNestedHandleView() {
  const items = useHandle(PprNestedHandle) ?? [];
  return (
    <div data-testid="ppr-nested-handle-view">
      {items.map((item) => (
        <Suspense
          key={item.label}
          fallback={
            <span data-testid="ppr-nested-handle-fallback">
              nested handle pending...
            </span>
          }
        >
          <Value promise={item.value} />
        </Suspense>
      ))}
    </div>
  );
}
