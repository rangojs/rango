import { Context, createContext } from "react";

/**
 * Minimal outlet context - only passes segment ID
 *
 * Components use useSegment(segmentId) to subscribe to actual segment data
 * from the segment store. This prevents cascading re-renders when segment
 * data changes - only components subscribed to that specific segment update.
 */
export interface OutletContextValueV2 {
  segmentId: string;
}

export const OutletContextV2: Context<OutletContextValueV2 | null> =
  createContext<OutletContextValueV2 | null>(null);
