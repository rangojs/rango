"use client";

import { useTransition } from "react";
import { useLoader } from "@rangojs/router/client";
import { DashboardLoader } from "../loaders.js";
import { bumpDashboard } from "../actions.js";

// Reads the registered DashboardLoader's data (preloaded on the server) and
// bumps it via a server action. The route's revalidate() re-runs the loader
// after the action, so the value updates with no navigation.
export function Metrics() {
  const { data, isLoading } = useLoader(DashboardLoader);
  const [isPending, startTransition] = useTransition();

  return (
    <div data-testid="metrics">
      <div data-testid="metrics-value">Value: {data ? data.value : "..."}</div>
      {isLoading && <span data-testid="metrics-loading">loading</span>}
      <button
        data-testid="metrics-bump"
        disabled={isPending}
        onClick={() =>
          startTransition(async () => {
            await bumpDashboard();
          })
        }
      >
        Bump
      </button>
    </div>
  );
}
