"use client";

import { useState } from "react";
import { ColocatedFrMarker } from "./ColocatedFrShared.js";

// Client island. Importing ColocatedFrMarker from the non-"use client"
// ColocatedFrShared.tsx pulls that file into the client module graph behind
// this client-reference boundary. The counter holds local state so the HMR
// test can prove an edit to ColocatedFrShared.tsx is applied as Fast Refresh
// (state preserved) rather than a remount or full reload.
export function ColocatedFrIsland() {
  const [count, setCount] = useState(0);
  return (
    <div data-testid="colocated-fr-island">
      <ColocatedFrMarker />
      <button
        data-testid="colocated-fr-count"
        onClick={() => setCount((c) => c + 1)}
      >
        count: {count}
      </button>
    </div>
  );
}
