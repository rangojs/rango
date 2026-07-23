"use client";

import { useState } from "react";

// Shell material: an interactive client island in the frozen prelude. It carries
// no per-request data, so its SSR output is deterministic and the cached shell
// hydrates cleanly. Clicking it proves the shell bytes hydrated and the app is
// interactive on top of the resumed document.
export function ShellCacheCounter() {
  const [count, setCount] = useState(0);
  return (
    <button
      type="button"
      data-testid="shell-counter"
      onClick={() => setCount((c) => c + 1)}
    >
      count: {count}
    </button>
  );
}
