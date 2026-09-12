"use client";

import { createContext, type Context } from "react";

/**
 * Route identity of an optimistically rendered clientUrls() destination:
 * the values the local trie match produced for the URL the user navigated
 * to. Provided by ClientUrlsRoot around the optimistic branch ONLY, so
 * useParams / usePathname / useSearchParams inside that branch describe the
 * route being rendered while the same hooks in chrome outside it keep the
 * committed location until the canonical response commits (or redirects, in
 * which case the branch — and these values — are discarded).
 */
export interface OptimisticLocation {
  readonly params: Readonly<Record<string, string>>;
  readonly pathname: string;
  /** Search string including the leading "?" (or ""). */
  readonly search: string;
}

export const OptimisticLocationContext: Context<OptimisticLocation | null> =
  createContext<OptimisticLocation | null>(null);
