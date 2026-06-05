"use client";

// Route-colocated client component for the /widgets route. With
// `clientChunks: true` (mini's vite config), this directory ("routes/widgets")
// becomes its own client chunk "app-widgets-*.js" plus a matching stylesheet
// from widget.css, so visiting /charts does NOT download this code or CSS.

import { useState } from "react";
import "./widget.css";
import { Badge } from "./components/Badge.js";

export function WidgetA() {
  const [count, setCount] = useState(0);
  return (
    <div data-testid="widget-a" className="mini-widget-a">
      <button data-testid="widget-a-btn" onClick={() => setCount((c) => c + 1)}>
        widget-a count: {count}
      </button>
      <Badge />
    </div>
  );
}
