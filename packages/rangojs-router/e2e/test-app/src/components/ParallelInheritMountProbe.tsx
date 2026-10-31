"use client";

import { useState } from "react";
import { useLoader } from "@rangojs/router/client";
import { ParallelInheritRunsLoader } from "../loaders.js";
import { parallelInheritTouch } from "../urls/parallel-loader-inherit.actions.js";

/**
 * Local state in the layout that inherits the route's loaders: a remount of
 * the layout resets the count.
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
