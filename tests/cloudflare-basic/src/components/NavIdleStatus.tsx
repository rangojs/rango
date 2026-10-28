"use client";

import { useNavigation } from "@rangojs/router/client";
import { navIdleSlowAction } from "../actions/nav-idle.js";

/**
 * useNavigation() while a navigation or a server action runs: `state` is
 * loading for both, `isNavigating` for the navigation only (a progress bar).
 */
export function NavIdleStatus(): React.ReactNode {
  const nav = useNavigation();
  return (
    <div>
      <p data-testid="nav-idle-status">
        {`state:${nav.state} navigating:${nav.isNavigating}`}
      </p>
      <button
        type="button"
        data-testid="nav-idle-action"
        onClick={() => void navIdleSlowAction()}
      >
        run action
      </button>
    </div>
  );
}
