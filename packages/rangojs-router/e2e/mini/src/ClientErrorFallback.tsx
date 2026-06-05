"use client";

// A "use client" error-boundary fallback registered via errorBoundary(). With
// the built-in clientChunks strategy this module is pulled into a dedicated
// "app-fallback" chunk (not co-bundled with the route code it catches failures
// for, and so the route's chunk is named after a real module, not this boundary).
// The unique "mini-client-error" marker lets the build-graph test assert it lands
// only in app-fallback. useState makes it a genuinely interactive client ref.

import { useState } from "react";

export function ClientErrorFallback() {
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <div data-testid="client-error-fallback" className="mini-client-error">
      <p>caught: {acknowledged ? "acknowledged" : "boom"}</p>
      <button
        data-testid="client-error-ack"
        onClick={() => setAcknowledged(true)}
      >
        acknowledge
      </button>
    </div>
  );
}
