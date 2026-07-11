"use client";

import { useActionState } from "react";
import { useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";
import { incrementHoleAction } from "../actions/shell-cache-action.js";
import type { ShellActionCounterData } from "../urls/shell-cache-action.defs.js";

// 10(a): the live HOLE. Reads the loader (masked at capture, fresh on serve) and
// carries a JS action that mutates the loader-fed module state. After the action
// the client applies the result; a later hard GET stays HIT and the hole shows the
// mutated value (loaders live under PPR — no invalidation needed).
export function ShellActionHole({
  loader,
}: {
  loader: LoaderDefinition<ShellActionCounterData>;
}) {
  const {
    data: { count, seq },
  } = useLoader(loader);
  const [state, formAction, isPending] = useActionState(async () => {
    return await incrementHoleAction();
  }, null);

  return (
    <div data-testid="shell-action-hole" data-seq={seq}>
      <span data-testid="shell-action-count">
        Count: {count} (seq {seq})
      </span>
      <form action={formAction}>
        <button
          type="submit"
          disabled={isPending}
          data-testid="shell-action-increment"
        >
          Increment
        </button>
      </form>
      {state && (
        <span data-testid="shell-action-result">applied: {state.count}</span>
      )}
    </div>
  );
}
