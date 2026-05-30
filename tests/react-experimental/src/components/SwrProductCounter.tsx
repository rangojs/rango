"use client";

import { useState } from "react";

/**
 * Client component with local useState, used by the /swr-product/:id route to
 * prove same-route navigation reconciles (does not remount): the counter's
 * state persists across /swr-product/1 -> /swr-product/2. On a cross-route
 * navigation the route remounts and the counter resets.
 */
export function SwrProductCounter(): React.ReactNode {
  const [count, setCount] = useState(0);
  return (
    <button
      type="button"
      data-testid="swr-product-counter"
      onClick={() => setCount((c) => c + 1)}
    >
      count: {count}
    </button>
  );
}
