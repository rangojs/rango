"use client";

// app/-rooted layout fixture (issue #1022): src/app/routes/split-hero/ is its
// own client group (app-split-hero), not one app-routes group shared with
// src/app/routes/split-gallery/.

import { useState } from "react";

export function SplitHero() {
  const [count, setCount] = useState(0);
  return (
    <div data-testid="split-hero" className="cf-app-split-hero">
      <button
        data-testid="split-hero-btn"
        onClick={() => setCount((c) => c + 1)}
      >
        split-hero count: {count}
      </button>
    </div>
  );
}
