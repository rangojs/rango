"use client";

import { useLoader } from "@rangojs/router/client";
import { SharedRefetchLoader } from "../loaders.js";

/**
 * Layout-position client read of SharedRefetchLoader. Owns the refetch
 * button — the test clicks this and asserts that the page-level and
 * sibling reads of the same loader also pick up the new value.
 */
export function SharedRefetchLayoutWidget() {
  const { data, load } = useLoader(SharedRefetchLoader);
  return (
    <div data-testid="shared-refetch-layout-widget">
      <p>
        layout count:{" "}
        <span data-testid="shared-refetch-layout-value">{data.count}</span>
      </p>
      <button
        data-testid="shared-refetch-layout-load-btn"
        onClick={() => load()}
      >
        Refetch from layout
      </button>
    </div>
  );
}
