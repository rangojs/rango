"use client";

import { useEffect, useState } from "react";
import { useAction, useLoader, useNavigation } from "@rangojs/router/client";
import {
  ActionStaleCartDefaultLoader,
  ActionStaleCartLoader,
  ActionStaleFillLoader,
  ActionStalePlainLoader,
} from "./action-stale.defs.js";
import {
  addToActionStaleCart,
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

// The last result useAction() reported for the add action: it holds one only
// while the action settles.
function ActionStaleActionResult() {
  const { result } = useAction(addToActionStaleCart);
  const [last, setLast] = useState<unknown>(null);
  useEffect(() => {
    if (result != null) setLast(result);
  }, [result]);
  return <p data-testid="as-action-result">{String(last ?? "")}</p>;
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

export function ActionStaleFillValue() {
  const { data } = useLoader(ActionStaleFillLoader);
  return <p data-testid="as-fill">{`fill:${data}`}</p>;
}
