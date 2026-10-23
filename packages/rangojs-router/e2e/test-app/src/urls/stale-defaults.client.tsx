"use client";

import { useLoader } from "@rangojs/router/client";
import { StaleDefaultsCartLoader } from "./stale-defaults.defs.js";
import {
  addToStaleDefaultsCart,
  addToStaleDefaultsKeyed,
} from "./stale-defaults.actions.js";

// <html data-sd-result> holds the count the last add returned.
async function add(call: () => Promise<number>): Promise<void> {
  const html = document.documentElement;
  html.removeAttribute("data-sd-result");
  html.setAttribute("data-sd-result", String(await call()));
}

function AddButton({
  testId,
  call = addToStaleDefaultsCart,
}: {
  testId: string;
  call?: () => Promise<number>;
}) {
  return (
    <button data-testid={testId} onClick={() => void add(call)}>
      Add
    </button>
  );
}

/** The layout's cart count, from its loader, and an add button. */
export function StaleDefaultsBar() {
  const { data: cart } = useLoader(StaleDefaultsCartLoader);
  return (
    <div>
      <p data-testid="sd-cart">{`cart:${cart}`}</p>
      <AddButton testId="sd-add" />
    </div>
  );
}

export function StaleDefaultsIntercept({ id }: { id: string }) {
  return (
    <div role="dialog" data-testid="sd-intercept">
      <p data-testid="sd-intercept-id">{id}</p>
      <AddButton testId="sd-intercept-add" />
    </div>
  );
}

/** The cache() and ppr pages' add: their count is keyed by the page's ?k. */
export function StaleDefaultsKeyedAdd({
  k,
  testId,
}: {
  k: string;
  testId: string;
}) {
  return <AddButton testId={testId} call={() => addToStaleDefaultsKeyed(k)} />;
}
