"use client";

import { useActionState, useTransition } from "react";
import { txCountAction, txFailingAction } from "../actions.js";

/**
 * transition({ when }) e2e probe: useActionState survives an action commit its
 * predicate gates off (no remount). The browser calls txCountAction with
 * (prevState, formData), so the predicate sees `action.formData` and
 * `action.result`.
 */
export function TxActionProbe() {
  const [count, run, pending] = useActionState(txCountAction, 0);
  return (
    <form action={run}>
      <input type="hidden" name="probe" value="1" />
      <button type="submit" data-testid="tx-action-run">
        {`actions:${count}${pending ? " (pending)" : ""}`}
      </button>
    </form>
  );
}

/**
 * A failing action: the route's errorBoundary() commits (the error lane). The
 * rejection is caught so it does not also reach a client error boundary.
 */
export function TxFailProbe() {
  const [, startTransition] = useTransition();
  return (
    <button
      type="button"
      data-testid="tx-action-fail"
      onClick={() => startTransition(() => txFailingAction().catch(() => {}))}
    >
      fail
    </button>
  );
}
