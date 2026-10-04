"use client";

import { useLoader } from "@rangojs/router/client";
import { FeatureLoader } from "../loaders/feature.js";
import { useStatusLog } from "./status-log.js";

/**
 * Route-level probe for useLoader's isLoading during a held same-route
 * navigation: renders "<stale|fresh>:<slug>" and logs the sequence.
 */
export function FeatureStatus(): React.ReactNode {
  const { data, isLoading } = useLoader(FeatureLoader);
  const status = `${isLoading ? "stale" : "fresh"}:${data.slug}`;
  useStatusLog("__featureStatusLog", status);
  return <p data-testid="feature-status">{status}</p>;
}
