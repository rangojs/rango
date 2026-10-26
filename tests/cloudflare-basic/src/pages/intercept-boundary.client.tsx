"use client";

import { useLoader, useRouter } from "@rangojs/router/client";
import { InterceptBoundaryCartLoader } from "./intercept-boundary.defs.js";
import {
  addToInterceptBoundaryCart,
  failInterceptBoundaryItem,
} from "./intercept-boundary.actions.js";

// <html data-ib-result> holds what the last call settled with.
async function run(call: () => Promise<unknown>): Promise<void> {
  const html = document.documentElement;
  html.removeAttribute("data-ib-result");
  try {
    html.setAttribute("data-ib-result", String(await call()));
  } catch {
    html.setAttribute("data-ib-result", "error");
  }
}

/** The layout's cart count, and a button that calls router.refresh(). */
export function InterceptBoundaryBar() {
  const { data: cart } = useLoader(InterceptBoundaryCartLoader);
  const router = useRouter();
  return (
    <div>
      <p data-testid="ib-cart">{`cart:${cart}`}</p>
      <button data-testid="ib-refresh" onClick={() => void router.refresh()}>
        Refresh
      </button>
    </div>
  );
}

export function InterceptBoundaryAdd() {
  return (
    <button
      data-testid="ib-add"
      onClick={() => void run(() => addToInterceptBoundaryCart())}
    >
      Add
    </button>
  );
}

/** The item's form: the action writes, then throws. */
export function InterceptBoundaryItemControls() {
  return (
    <button
      data-testid="ib-fail"
      onClick={() => void run(() => failInterceptBoundaryItem())}
    >
      Add, then fail
    </button>
  );
}
