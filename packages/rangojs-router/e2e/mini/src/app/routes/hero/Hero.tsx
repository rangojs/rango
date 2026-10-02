"use client";

// app/-rooted layout fixture (issue #1022): src/app/routes/hero/ splits into
// app-hero, not one app-routes group shared with app/routes/gallery/.

import { useState } from "react";

export function Hero() {
  const [count, setCount] = useState(0);
  return (
    <div data-testid="app-hero" className="mini-app-hero">
      <button data-testid="app-hero-btn" onClick={() => setCount((c) => c + 1)}>
        app-hero count: {count}
      </button>
    </div>
  );
}
