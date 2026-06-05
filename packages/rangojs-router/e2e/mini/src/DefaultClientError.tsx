"use client";

// A "use client" error fallback registered as a ROUTER-LEVEL default via
// createRouter({ defaultErrorBoundary }). Unlike the route-tree errorBoundary()
// helper, this never lands in EntryData — it lives on the router instance — so
// the build collects it from the router default, not the manifest walk. The
// "mini-default-error" marker lets the build-graph test assert it still reaches
// the dedicated app-fallback chunk.

import { useState } from "react";

export function DefaultClientError() {
  const [seen] = useState(true);
  return (
    <div data-testid="default-client-error" className="mini-default-error">
      default boundary {seen ? "active" : ""}
    </div>
  );
}
