"use client";

import { useState, useTransition } from "react";
import { incrementCounter, decrementCounter } from "../actions.js";

// Calls "use server" actions and applies their return value to local state.
export function Counter({ initialCount }) {
  const [count, setCount] = useState(initialCount);
  const [isPending, startTransition] = useTransition();

  return (
    <div data-testid="counter">
      <div data-testid="counter-value">Count: {count}</div>
      <button
        data-testid="counter-decrement"
        disabled={isPending}
        onClick={() =>
          startTransition(async () => setCount(await decrementCounter()))
        }
      >
        -1
      </button>
      <button
        data-testid="counter-increment"
        disabled={isPending}
        onClick={() =>
          startTransition(async () => setCount(await incrementCounter()))
        }
      >
        +1
      </button>
    </div>
  );
}
