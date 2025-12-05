"use client";

import { createContext, type Context } from "react";
import type { SegmentStore } from "../segment-store.js";

/**
 * Context for the segment store
 *
 * Provides access to the segment store throughout the component tree.
 * Components use useSegment() to subscribe to specific segments.
 */
export const SegmentStoreContext: Context<SegmentStore | null> =
  createContext<SegmentStore | null>(null);
