/**
 * Browser-side service initialization.
 *
 * Before client loaders run, services attached to segments need their
 * instances initialized from server-provided init data. This module
 * walks segments and calls initializeService() for each service that
 * hasn't been initialized yet.
 *
 * Must be called BEFORE prepareClientLoaders() so that client loaders
 * can access service instances via ctx.use(service).
 */

import type { ResolvedSegment } from "../types.js";
import { initializeService, hasServiceInstance } from "./service-registry.js";

/**
 * Initialize services from segment data.
 *
 * Walks all segments and initializes any services that have serviceData
 * (init data from server fns). Already-initialized services are skipped
 * (they persist across SPA navigations).
 *
 * @param segments - All segments for the current navigation
 */
export function prepareServices(segments: ResolvedSegment[]): void {
  if (typeof window === "undefined") return;

  for (const segment of segments) {
    if (!segment.serviceIds || segment.serviceIds.length === 0) continue;

    for (const serviceId of segment.serviceIds) {
      // Skip if already initialized (persists across navigations)
      if (hasServiceInstance(serviceId)) continue;

      // Initialize with server-provided data if available
      const initData = segment.serviceData?.[serviceId];
      if (initData !== undefined) {
        initializeService(serviceId, initData);
      }
    }
  }
}
