"use client";

import { useState } from "react";

/**
 * Client component with local useState, used by the /swr-product/:id route to
 * prove same-route navigation behavior. On a same-route navigation the route
 * subtree reconciles (does not remount), so this counter's state persists
 * across /swr-product/1 -> /swr-product/2. On a cross-route navigation the
 * route remounts and the counter resets.
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
