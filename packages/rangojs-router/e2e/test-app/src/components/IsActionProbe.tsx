"use client";

import { useActionState } from "react";
import { useLoader } from "@rangojs/router/client";
import { IsActionProbeLoader } from "../loaders.js";
import { isActionTargetAction, isActionDecoyAction } from "../actions.js";

/**
 * Displays the probe loader's run counter and two buttons that fire the target
 * and decoy actions. The target action re-runs the loader (ctx.isAction match);
 * the decoy does not. The test reads `is-action-runs` before/after each click.
 */
export function IsActionProbe() {
  const { data } = useLoader(IsActionProbeLoader);

  const [, fireTarget, targetPending] = useActionState(async () => {
    await isActionTargetAction();
    return null;
  }, null);

  const [, fireDecoy, decoyPending] = useActionState(async () => {
    await isActionDecoyAction();
    return null;
  }, null);

  return (
    <div>
      <span data-testid="is-action-runs">{data.runs}</span>
      <form action={fireTarget}>
        <button
          type="submit"
          data-testid="is-action-target-btn"
          disabled={targetPending}
        >
          Target
        </button>
      </form>
      <form action={fireDecoy}>
        <button
          type="submit"
          data-testid="is-action-decoy-btn"
          disabled={decoyPending}
        >
          Decoy
        </button>
      </form>
    </div>
  );
}
