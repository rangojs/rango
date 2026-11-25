import { type Context, createContext, type ReactNode } from "react";
import type { ResolvedSegment } from "./types";

/**
 * What an outlet draws, declared by whoever builds its context:
 * segment-system.tsx for a server layout, ClientUrlsRoot for a clientUrls()
 * group layout level.
 */
export interface OutletDraws {
  /** Opaque id of the route or layout drawn, the same for every URL of it. */
  readonly route: string;
  /** The drawn element's identity: the route plus the params its key carries. */
  readonly key: string;
  /** "group-layout": a clientUrls() group layout level, holding the page under it. */
  readonly kind: "page" | "group-layout";
}

export interface OutletContextValue {
  content: ReactNode;
  /** What `content` is; absent where nothing declares it. */
  draws?: OutletDraws;
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
   * (loader(Def, { ssr: "await" })). Dev-diagnostic input only: useLoader uses
   * it to warn when a read still suspends during SSR on a render that awaited
   * flagged loaders (ssr-suspension-warning.ts). Present only where a
   * segment carries flagged loaders (document and shell-capture renders, and
   * a client lane that re-renders their segments); a settled read never
   * suspends, so it never warns.
   */
  awaitedLoaderIds?: readonly string[];
  /**
   * Loader $$ids a clientUrls() frame's destination reads before its
   * canonical commit (ClientUrlsRoot): a read reaching this level suspends
   * until the commit brings the data (findLoaderRead, use-loader.tsx).
   */
  awaitingCommit?: readonly string[];
  parent?: OutletContextValue | null;
  /** Loading component for Suspense fallback (from segment's loading() definition) */
  loading?: ReactNode;
}

export const OutletContext: Context<OutletContextValue | null> =
  createContext<OutletContextValue | null>(null);
