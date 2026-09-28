"use client";

import { useState, useTransition } from "react";
import { invalidateFreshReadsShell } from "../actions/fresh-reads.js";

/** Runs the invalidating server action (the e2e then reloads the page). */
export function FreshReadsButton({ probe }: { probe: string }) {
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      data-testid="fresh-reads-invalidate"
      data-done={done ? "true" : "false"}
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await invalidateFreshReadsShell(probe);
          setDone(true);
        })
      }
    >
      Invalidate the shell
    </button>
  );
}
