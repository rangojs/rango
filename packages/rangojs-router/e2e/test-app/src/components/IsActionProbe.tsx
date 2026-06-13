"use client";

import { useActionState } from "react";
import { useLoader } from "@rangojs/router/client";
import { IsActionProbeLoader, IsActionAnyLoader } from "../loaders.js";
import { isActionTargetAction, isActionDecoyAction } from "../actions.js";

/**
 * Displays the probe loaders' run counters and two buttons that fire the target
 * and decoy actions. The target-gated loader (`is-action-runs`) re-runs only on
 * the target action; the bare-isAction()-gated loader (`is-action-any-runs`)
 * re-runs on ANY action. The test reads both counters before/after each click.
 */
export function IsActionProbe() {
  const { data } = useLoader(IsActionProbeLoader);
  const { data: anyData } = useLoader(IsActionAnyLoader);

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
      <span data-testid="is-action-any-runs">{anyData.runs}</span>
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
