"use client";

import { useFetchLoader } from "@rangojs/router/client";
import { SharedRefetchLoader } from "../loaders.js";

/**
 * Third read site, this one via useFetchLoader instead of useLoader.
 * Mirrors the realistic case where a parallel slot or modal subscribes
 * to the same loader. Should also see the layout's refetch.
 */
export function SharedRefetchSibling() {
  const { data } = useFetchLoader(SharedRefetchLoader);
  return (
    <div data-testid="shared-refetch-sibling">
      sibling count:{" "}
      <span data-testid="shared-refetch-sibling-value">
        {data?.count ?? "—"}
      </span>
    </div>
  );
}
