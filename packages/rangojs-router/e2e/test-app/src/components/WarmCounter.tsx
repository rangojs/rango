"use client";

import { useState } from "react";

/** Hydration proof for the prerender-warm fixture: a click only counts once React owns the button. */
export function WarmCounter() {
  const [count, setCount] = useState(0);
  return (
    <button
      type="button"
      data-testid="warm-counter"
      onClick={() => setCount((value) => value + 1)}
    >
      {count}
    </button>
  );
}
