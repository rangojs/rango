"use client";

import { useState, useTransition } from "react";
import { incrementCounter, decrementCounter } from "../actions/counter.js";

interface CounterProps {
  initialCount: number;
}

export function Counter({ initialCount }: CounterProps) {
  const [count, setCount] = useState(initialCount);
  const [isPending, startTransition] = useTransition();

  const handleIncrement = () => {
    startTransition(async () => {
      const newCount = await incrementCounter();
      setCount(newCount);
    });
  };

  const handleDecrement = () => {
    startTransition(async () => {
      const newCount = await decrementCounter();
      setCount(newCount);
    });
  };

  return (
    <div data-testid="counter">
      <div
        className="counter"
        style={{ opacity: isPending ? 0.5 : 1 }}
        data-testid="counter-value"
      >
        Count: {count}
      </div>
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button
          onClick={handleDecrement}
          disabled={isPending}
          data-testid="counter-decrement"
        >
          -1
        </button>
        <button
          onClick={handleIncrement}
          disabled={isPending}
          data-testid="counter-increment"
        >
          +1
        </button>
      </div>
      {isPending && (
        <p
          style={{ marginTop: "0.5rem", color: "#666" }}
          data-testid="counter-pending"
        >
          Updating...
        </p>
      )}
    </div>
  );
}
