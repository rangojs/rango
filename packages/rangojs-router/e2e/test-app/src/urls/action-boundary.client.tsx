"use client";

import { useEffect, useState } from "react";
import { useAction, useLoader } from "@rangojs/router/client";
import { ActionBoundaryCartLoader } from "./action-boundary.defs.js";
import {
  addToActionBoundaryCart,
  failActionBoundaryCart,
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
 * The layout's cart count, and the fail action's error as useAction()
 * reports it (it holds one only while the action settles).
 */
export function ActionBoundaryBar() {
  const { data: cart } = useLoader(ActionBoundaryCartLoader);
  const { error } = useAction(failActionBoundaryCart);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (error != null) setFailed(true);
  }, [error]);
  return (
    <div>
      <p data-testid="ab-cart">{`cart:${cart}`}</p>
      <p data-testid="ab-action-error">{failed ? "error" : ""}</p>
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
    </div>
  );
}
