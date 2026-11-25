"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type Context,
} from "react";
import type { ReadonlyURLSearchParams } from "./browser/types.js";

/**
 * The URL an outlet with `keep` draws, handed to `keep.key`. `route` is an
 * opaque id of what the outlet draws for that URL: the route, or the nested
 * layout between the outlet and the route. It is the same for every URL of
 * that route.
 */
export interface KeptTo {
  readonly route: string;
  readonly params: Readonly<Record<string, string>>;
  readonly search: ReadonlyURLSearchParams;
}

/** `<Outlet keep={...} />`: keep the pages the outlet leaves mounted and hidden. */
export interface OutletKeepOptions {
  /**
   * How many left pages stay mounted and hidden beside the one shown: a whole
   * number 0 or more, or `Infinity`.
   */
  max: number;
  /**
   * Which entry a URL belongs to. Two URLs with one key are one entry: a param
   * or search change between them reconciles the page on screen. Default: the
   * route and its params for a server route, the route alone in a
   * `clientUrls()` group.
   */
  key?: (to: KeptTo) => string;
}

/** What a keeping outlet tells the page of one of its entries. */
export interface KeptEntryState {
  readonly hidden: boolean;
  /** How many times the entry was shown again after a hide, outer keeps included. */
  readonly shows: number;
  /** True while the entry is drawn back from hidden on a clientUrls() frame. */
  readonly returning: boolean;
  /** Read at call time: an event or a late promise in a hidden page. */
  readonly isHidden: () => boolean;
  /** The outlet's own handle, one object for its lifetime (useKeptOutlet). */
  readonly outlet: { readonly drop: (key: string) => void };
}

export const KeptEntryContext: Context<KeptEntryState | null> =
  createContext<KeptEntryState | null>(null);

const VISIBLE = { hidden: false } as const;
const HIDDEN = { hidden: true } as const;

/**
 * Whether the page renders hidden in an `<Outlet keep />`. A page outside any
 * keeping outlet is never hidden.
 */
export function useKept(): { readonly hidden: boolean } {
  return useContext(KeptEntryContext)?.hidden ? HIDDEN : VISIBLE;
}

/**
 * Runs `callback` when an `<Outlet keep />` shows the page again after a hide.
 * Never on a plain mount, StrictMode's second mount included. A show re-runs
 * every effect of the page, so an effect guarded by a "run once" ref needs
 * this to run its work again.
 */
export function useKeptShow(callback: () => void): void {
  const shows = useContext(KeptEntryContext)?.shows ?? 0;
  const seen = useRef(shows);
  const latest = useRef(callback);
  latest.current = callback;
  useEffect(() => {
    if (shows === seen.current) return;
    seen.current = shows;
    latest.current();
  }, [shows]);
}

const NO_DROP = { drop: (_key: string): void => {} };

/**
 * The nearest `<Outlet keep />` around the page. `drop(key)` forgets a hidden
 * entry, so its next visit mounts it again (after deleting what it showed,
 * say). The key is what `keep.key` returns for it; the entry on screen is not
 * dropped.
 */
export function useKeptOutlet(): { readonly drop: (key: string) => void } {
  return useContext(KeptEntryContext)?.outlet ?? NO_DROP;
}
