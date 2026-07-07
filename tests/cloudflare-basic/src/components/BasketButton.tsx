"use client";

import { useState, useTransition } from "react";
import { addToBasket } from "../actions/basket.js";

export function BasketButton() {
  const [count, setCount] = useState<number | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <div data-testid="basket">
      <button
        data-testid="basket-add"
        disabled={isPending}
        onClick={() => {
          startTransition(async () => {
            setCount(await addToBasket());
          });
        }}
      >
        Add to basket
      </button>
      <span data-testid="basket-count">{count ?? "empty"}</span>
    </div>
  );
}
