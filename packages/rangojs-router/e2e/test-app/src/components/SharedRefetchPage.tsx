"use client";

import { useLoader } from "@rangojs/router/client";
import { SharedRefetchLoader } from "../loaders.js";

/**
 * Page-position read of the same SharedRefetchLoader. After the layout
 * triggers refetch, this read site should reflect the new count too.
 */
export function SharedRefetchPage() {
  const { data } = useLoader(SharedRefetchLoader);
  return (
    <div data-testid="shared-refetch-page">
      page count:{" "}
      <span data-testid="shared-refetch-page-value">{data.count}</span>
    </div>
  );
}
