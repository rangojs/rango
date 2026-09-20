"use client";

import { useLoader } from "@rangojs/router/client";
import { SwrProductLoader } from "../loaders.js";
import { useStatusLog } from "./status-log.js";

/**
 * Route-level probe for useLoader's isLoading during a held same-route
 * navigation: renders "<stale|fresh>:<name>" and logs the sequence.
 */
export function SwrProductStatus(): React.ReactNode {
  const { data, isLoading } = useLoader(SwrProductLoader);
  const status = `${isLoading ? "stale" : "fresh"}:${data.name}`;
  useStatusLog("__swrStatusLog", status);
  return <p data-testid="swr-product-status">{status}</p>;
}
