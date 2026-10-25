"use client";

import { useEffect, useState } from "react";
import { useAction, useLoader, useNavigation } from "@rangojs/router/client";
import { ActionBoundaryCartLoader } from "./action-boundary.defs.js";
import {
  addToActionBoundaryCart,
  failActionBoundaryCart,
  failLateActionBoundaryCart,
  slowActionBoundaryAction,
} from "./action-boundary.actions.js";

// <html data-ab-result> holds what the last call settled with.
async function run(call: () => Promise<unknown>): Promise<void> {
  const html = document.documentElement;
  html.removeAttribute("data-ab-result");
  try {
    html.setAttribute("data-ab-result", String(await call()));
  } catch {
    html.setAttribute("data-ab-result", "error");
  }
}

/**
 * The layout's cart count, the fail action's error as useAction() reports
 * it (it holds one only while the action settles), and useNavigation().
 */
export function ActionBoundaryBar() {
  const { data: cart } = useLoader(ActionBoundaryCartLoader);
  const { error } = useAction(failActionBoundaryCart);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (error != null) setFailed(true);
  }, [error]);
  const { state: navState } = useNavigation();
  const { error: lateError } = useAction(failLateActionBoundaryCart);
  const [lateFailed, setLateFailed] = useState(false);
  useEffect(() => {
    if (lateError != null) setLateFailed(true);
  }, [lateError]);
  return (
    <div>
      <p data-testid="ab-cart">{`cart:${cart}`}</p>
      <p data-testid="ab-action-error">{failed ? "error" : ""}</p>
      <p data-testid="ab-late-error">{lateFailed ? "error" : ""}</p>
      <p data-testid="ab-nav-state">{navState}</p>
    </div>
  );
}

export function ActionBoundaryControls() {
  return (
    <div>
      <button
        data-testid="ab-add"
        onClick={() => void run(() => addToActionBoundaryCart())}
      >
        Add
      </button>
      <button
        data-testid="ab-fail"
        onClick={() => void run(() => failActionBoundaryCart())}
      >
        Add, then fail
      </button>
      <button
        data-testid="ab-fail-late"
        onClick={() => void run(() => failLateActionBoundaryCart())}
      >
        Add, then fail late
      </button>
    </div>
  );
}

/**
 * The slow action's useAction() state on the page the user moved to. Its
 * result and error are kept once seen: useAction() holds them only while
 * the action settles.
 */
export function ActionBoundarySlowControls() {
  const { state, result, error } = useAction(slowActionBoundaryAction);
  const [seenResult, setSeenResult] = useState("");
  useEffect(() => {
    if (result != null) setSeenResult(String(result));
  }, [result]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (error != null) setFailed(true);
  }, [error]);
  return (
    <div>
      <button
        data-testid="ab-slow"
        onClick={() => void run(() => slowActionBoundaryAction())}
      >
        Slow
      </button>
      <p data-testid="ab-slow-state">{state}</p>
      <p data-testid="ab-slow-result">{seenResult}</p>
      <p data-testid="ab-slow-error">{failed ? "error" : ""}</p>
    </div>
  );
}
