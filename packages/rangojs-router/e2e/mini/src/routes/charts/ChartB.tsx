"use client";

// Route-colocated client component for the /charts route. With
// `clientChunks: true` this directory ("routes/charts") becomes its own client
// chunk "app-charts-*.js" plus a matching stylesheet from chart.css.

import { useState } from "react";
import "./chart.css";
import { Badge } from "./components/Badge.js";

export function ChartB() {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid="chart-b" className="mini-chart-b">
      <button data-testid="chart-b-btn" onClick={() => setOpen((o) => !o)}>
        chart-b {open ? "open" : "closed"}
      </button>
      <Badge />
    </div>
  );
}
