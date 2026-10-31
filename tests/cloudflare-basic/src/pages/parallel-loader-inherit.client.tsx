"use client";

import { useState } from "react";
import { useLoader } from "@rangojs/router/client";
import { parallelInheritTouch } from "./parallel-loader-inherit.actions.js";
import { ParallelInheritRunsLoader } from "./parallel-loader-inherit.defs.js";

/**
 * Local state in the layout that would inherit the route's loaders: a
 * remount of the layout resets the count.
 */
export function ParallelInheritMountProbe() {
  const [clicks, setClicks] = useState(0);
  return (
    <div>
      <button
        type="button"
        data-testid="inherit-probe-click"
        onClick={() => setClicks((c) => c + 1)}
      >
        click
      </button>
      <span data-testid="inherit-probe-clicks">{clicks}</span>
      <button
        type="button"
        data-testid="inherit-probe-action"
        onClick={() => {
          void parallelInheritTouch();
        }}
      >
        action
      </button>
    </div>
  );
}

/** The route loader's runs, read from the layout's parallel slot. */
export function ParallelInheritRuns() {
  const { data } = useLoader(ParallelInheritRunsLoader);
  return <span data-testid="inherit-probe-runs">{data.runs}</span>;
}
