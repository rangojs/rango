"use client";

import { useLoader } from "@rangojs/router/client";
import { FeatureShellLoader } from "../loaders/feature.js";
import { useStatusLog } from "./status-log.js";

/**
 * Layout-level probe: reads FeatureShellLoader (registered on FeaturesShell,
 * not re-run by a feature -> feature nav). Must never report "stale" while the
 * route's FeatureLoader streams.
 */
export function FeatureShellStatus(): React.ReactNode {
  const { data, isLoading } = useLoader(FeatureShellLoader);
  const status = `${isLoading ? "stale" : "fresh"}:${data.label}`;
  useStatusLog("__featureShellStatusLog", status);
  return (
    <p data-testid="feature-shell-status" data-loaded-at={data.loadedAt}>
      {status}
    </p>
  );
}
