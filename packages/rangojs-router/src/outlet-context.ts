import { type Context, createContext, type ReactNode } from "react";
import type { ResolvedSegment } from "./types";

export interface OutletContextValue {
  content: ReactNode;
  /** Unresolved client-route work owned by descendants of this outlet. */
  pending?: boolean;
  parallel?: ResolvedSegment[];
  segment?: ResolvedSegment;
  loaderData?: Record<string, any>;
  /**
   * SPIKE (streaming useLoader): per-loader UNDECODED results keyed by loader
   * $$id. A value may be a pending Promise (loader still streaming) or an
   * already-settled result entry. useLoader `use()`es a pending value at the
   * read site — implicit suspension to the nearest consumer Suspense boundary —
   * and decodes via decodeLoaderEntry. Populated instead of `loaderData` for
   * a route's or layout's loaders on every lane; forceAwait/action lanes hand
   * settled entries. `loaderData` is a slot's decoded aggregate.
   */
  loaderStreams?: Record<string, unknown>;
  /**
   * Loader $$ids on this segment that the render awaited before first flush
   * (loader(Def, { ssr: false })). Dev-diagnostic input only: useLoader uses
   * it to warn when a read still suspends during SSR on a render that awaited
   * flagged loaders (ssr-suspension-warning.ts). Present only where a
   * segment carries flagged loaders (document and shell-capture renders, and
   * a client lane that re-renders their segments); a settled read never
   * suspends, so it never warns.
   */
  awaitedLoaderIds?: readonly string[];
  parent?: OutletContextValue | null;
  /** Loading component for Suspense fallback (from segment's loading() definition) */
  loading?: ReactNode;
}

export const OutletContext: Context<OutletContextValue | null> =
  createContext<OutletContextValue | null>(null);
