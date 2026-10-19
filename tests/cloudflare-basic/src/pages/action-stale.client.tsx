"use client";

import { useLoader } from "@rangojs/router/client";
import {
  ActionStaleCartLoader,
  ActionStalePlainLoader,
} from "./action-stale.defs.js";
import { addToActionStaleCart } from "./action-stale.actions.js";

// <html data-as-pending> while an action is in flight: the bar is in the
// layout, which every page of the fixture keeps.
function run(writeAt: "first" | "last", ms: number): void {
  const html = document.documentElement;
  html.setAttribute("data-as-pending", "");
  const done = () => html.removeAttribute("data-as-pending");
  addToActionStaleCart(writeAt, ms).then(done, done);
}

export function ActionStaleBar() {
  const { data: cart } = useLoader(ActionStaleCartLoader);
  const { data: plain } = useLoader(ActionStalePlainLoader);
  return (
    <div>
      <p data-testid="as-cart">{`cart:${cart.cart}`}</p>
      <p data-testid="as-cart-runs">{cart.runs}</p>
      <p data-testid="as-plain">{plain}</p>
      <button data-testid="as-add-first" onClick={() => run("first", 500)}>
        Add, write first
      </button>
      <button data-testid="as-add-fast" onClick={() => run("first", 0)}>
        Add, write first, no delay
      </button>
      <button data-testid="as-add-last" onClick={() => run("last", 800)}>
        Add, write last
      </button>
    </div>
  );
}
