import { type Context, createContext, type ReactNode } from "react";
import type { ResolvedSegment } from "./types";

export interface OutletContextValue {
  content: ReactNode;
  /** Unresolved client-route work owned by descendants of this outlet. */
  pending?: boolean;
  parallel?: ResolvedSegment[];
  segment?: ResolvedSegment;
  loaderData?: Record<string, any>;
  parent?: OutletContextValue | null;
  /** Loading component for Suspense fallback (from segment's loading() definition) */
  loading?: ReactNode;
}

export const OutletContext: Context<OutletContextValue | null> =
  createContext<OutletContextValue | null>(null);
