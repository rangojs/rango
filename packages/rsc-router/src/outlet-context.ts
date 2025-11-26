import { Context, createContext, type ReactNode } from "react";
import type { ResolvedSegment } from "./types";

export interface OutletContextValue {
  content: ReactNode;
  parallel?: ResolvedSegment[];
  segment?: ResolvedSegment;
  loaderData?: Record<string, any>;
  parent?: OutletContextValue | null;
}

export const OutletContext: Context<OutletContextValue | null> =
  createContext<OutletContextValue | null>(null);
