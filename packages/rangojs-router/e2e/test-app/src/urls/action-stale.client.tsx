"use client";

import { useAction, useLoader, useNavigation } from "@rangojs/router/client";
import {
  ActionStaleCartDefaultLoader,
  ActionStaleCartLoader,
  ActionStaleCountLoader,
  ActionStaleFillLoader,
  ActionStalePlainLoader,
} from "./action-stale.defs.js";
import {
  addToActionStaleCart,
  addToActionStaleCartWith,
  failActionStaleCart,
} from "./action-stale.actions.js";

// <html data-as-pending> while an action is in flight, and
// <html data-as-result> with what its call settled with: the bar is in the
// layout, which every page of the fixture keeps.
function run(call: () => Promise<unknown>): void {
  const html = document.documentElement;
  html.setAttribute("data-as-pending", "");
  html.removeAttribute("data-as-result");
  call()
    .then(
      (value) => html.setAttribute("data-as-result", String(value)),
      () => html.setAttribute("data-as-result", "error"),
    )
    .finally(() => html.removeAttribute("data-as-pending"));
}

// The add action's result as useAction() reports it: kept until its next call.
function ActionStaleActionResult() {
  const { result } = useAction(addToActionStaleCart);
  return <p data-testid="as-action-result">{String(result ?? "")}</p>;
}

export function ActionStaleBar() {
  const { data: cart } = useLoader(ActionStaleCartLoader);
  const { data: plain } = useLoader(ActionStalePlainLoader);
  const { data: cartDefault } = useLoader(ActionStaleCartDefaultLoader);
  const navigation = useNavigation((nav) => nav.state);
  return (
    <div>
      <p data-testid="as-cart">{`cart:${cart.cart}`}</p>
      <p data-testid="as-cart-default">{`default:${cartDefault}`}</p>
      <p data-testid="as-navigation">{navigation}</p>
      <p data-testid="as-cart-runs">{cart.runs}</p>
      <p data-testid="as-plain">{plain}</p>
      <ActionStaleActionResult />
      <button
        data-testid="as-add-first"
        onClick={() => run(() => addToActionStaleCart("first", 500))}
      >
        Add, write first
      </button>
      <button
        data-testid="as-add-fast"
        onClick={() => run(() => addToActionStaleCart("first", 0))}
      >
        Add, write first, no delay
      </button>
      <button
        data-testid="as-add-keep"
        onClick={() => run(() => addToActionStaleCartWith("keep"))}
      >
        Add, keep the client cache
      </button>
      <button
        data-testid="as-add-invalidate"
        onClick={() => run(() => addToActionStaleCartWith("invalidate"))}
      >
        Add, invalidate the client cache
      </button>
      <button
        data-testid="as-add-last"
        onClick={() => run(() => addToActionStaleCart("last", 800))}
      >
        Add, write last
      </button>
      <button
        data-testid="as-fail"
        onClick={() => run(() => failActionStaleCart(false, 500))}
      >
        Add, then fail
      </button>
      <button
        data-testid="as-fail-keep"
        onClick={() => run(() => failActionStaleCart(true, 500))}
      >
        Add, keep the client cache, then fail
      </button>
    </div>
  );
}

// The bare layout's add (no loaders read): <html data-as-result> holds the
// count it wrote.
export function ActionStaleBareAdd() {
  return (
    <button
      data-testid="as-bare-add"
      onClick={() => run(() => addToActionStaleCart("first", 0))}
    >
      Add, write first, no delay
    </button>
  );
}

export function ActionStaleCount() {
  const { data } = useLoader(ActionStaleCountLoader);
  return <p data-testid="as-count">{`count:${data}`}</p>;
}

export function ActionStaleFillValue() {
  const { data } = useLoader(ActionStaleFillLoader);
  return <p data-testid="as-fill">{`fill:${data}`}</p>;
}
