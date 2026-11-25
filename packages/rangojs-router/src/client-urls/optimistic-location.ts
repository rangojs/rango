"use client";

import { createContext, type Context } from "react";
import type { PublicNavigationState } from "../browser/types.js";
import type { SegmentsState } from "../browser/react/use-segments.js";

/**
 * The location a subtree's URL hooks read instead of the committed one, the
 * one place they take it from (usePathname, useParams, useSearchParams,
 * useLocationState, useNavigation, useSegments).
 *
 * "frame": an optimistically rendered clientUrls() destination, the values the
 * local trie match produced for the URL the user navigated to. Provided by
 * ClientUrlsRoot around the optimistic branch ONLY, so the hooks inside that
 * branch describe the route being rendered while the same hooks in chrome
 * outside it keep the committed location until the canonical response commits
 * (or redirects, in which case the branch — and these values — are discarded).
 *
 * "kept": a page an `<Outlet keep />` hides, or shows again before its own
 * subscriptions catch up (outlet-keep.tsx): the location it was left at.
 */
export interface OptimisticLocation {
  readonly kind: "frame" | "kept";
  readonly params: Readonly<Record<string, string>>;
  readonly pathname: string;
  /** Search string including the leading "?" (or ""). */
  readonly search: string;
  /**
   * `history.state` the navigation will push: its `state` option, without
   * what the server adds (that arrives with the canonical commit). History
   * still holds the entry being left, so useLocationState reads this instead.
   */
  readonly state: unknown;
  /** "kept" only: what useNavigation reads instead of its own state. */
  readonly navigation?: PublicNavigationState;
  /** "kept" only: what useSegments reads instead of its own state. */
  readonly segments?: SegmentsState;
}

export const OptimisticLocationContext: Context<OptimisticLocation | null> =
  createContext<OptimisticLocation | null>(null);
