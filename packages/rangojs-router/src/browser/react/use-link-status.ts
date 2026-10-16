"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useOptimistic,
  type Context,
} from "react";
import { NavigationStoreContext } from "./context.js";
import type {
  EventController,
  NavigationEntry,
  RouteStateSignal,
} from "../event-controller.js";

/**
 * Context for Link component to provide its destination URL
 * Used by useLinkStatus to determine if this specific link is pending
 */
export const LinkContext: Context<string | null> = createContext<string | null>(
  null,
);

/**
 * Link status returned by useLinkStatus hook
 */
export interface LinkStatus {
  /** Whether navigation to this link's destination is in progress */
  pending: boolean;
}

/**
 * Normalize URL for comparison
 * Handles relative URLs and ensures consistent format
 */
function normalizeUrl(url: string, origin: string): string {
  try {
    const parsed = new URL(url, origin);
    // Return pathname + search + hash for comparison
    return parsed.pathname + parsed.search + parsed.hash;
  } catch {
    return url;
  }
}

/**
 * The navigation in flight a link can be pending for. One that shows no
 * loading state (a background revalidation, an action's refetch) is none: it
 * goes to no link and ends none whose page React still holds.
 */
function visibleNavigation(ec: EventController): NavigationEntry | null {
  const navigation = ec.getCurrentNavigation();
  return navigation && !navigation.options?.skipLoadingState
    ? navigation
    : null;
}

/**
 * Whether `navigation` goes to `linkTo`: its URL or, after a server redirect,
 * the URL its chain started from.
 */
function isPendingFor(
  linkTo: string | null,
  navigation: NavigationEntry | null,
  origin: string,
): boolean {
  if (linkTo === null || !navigation) {
    return false;
  }
  const to = normalizeUrl(linkTo, origin);
  const from = navigation.options?._redirectFrom;
  return (
    normalizeUrl(navigation.url, origin) === to ||
    (from !== undefined && normalizeUrl(from, origin) === to)
  );
}

/**
 * Hook to track the pending state of a Link component
 *
 * Must be used inside a Link component. Returns `{ pending: true }` while a
 * navigation to the link's destination is in flight, until the page it
 * brings commits: under transition() while React holds that page, and
 * through a server redirect until the target page commits. A newer
 * navigation ends it at once.
 *
 * Useful for showing inline loading indicators on individual links.
 *
 * @example
 * ```tsx
 * function LoadingIndicator() {
 *   const { pending } = useLinkStatus();
 *   return pending ? <Spinner /> : null;
 * }
 *
 * // In your component:
 * <Link to="/dashboard">
 *   Dashboard
 *   <LoadingIndicator />
 * </Link>
 * ```
 */
export function useLinkStatus(): LinkStatus {
  const linkTo = useContext(LinkContext);
  const ctx = useContext(NavigationStoreContext);

  const origin = ctx?.origin ?? "http://localhost";

  // The document renders no navigation in flight.
  const [pending, setPending] = useState<boolean>(
    () =>
      !!ctx &&
      !ctx.eventController.getHydrationSnapshot() &&
      isPendingFor(linkTo, visibleNavigation(ctx.eventController), origin),
  );
  const [shown, show] = useOptimistic(pending);

  // The value commits in the lane of the notification that carries it, as
  // useNavigation's does: urgent from the click's notification (a task of its
  // own), so it shows at once; in the page's lane when the commit clears the
  // navigation (NavigationProvider flushes it inside the page's update), so
  // it settles with the page, which React may hold. A transition of its own
  // would commit on its own, take the transition types queued for a held
  // page, and could start a view transition with none.
  //
  // Set once per navigation: a newer one re-derives every reader at its
  // call, so a link whose settle React holds with an earlier page ends there
  // instead of spinning beside the newer link. A reader whose value did not
  // move bails out in React. A background navigation is not a newer one: an
  // action's refetch while a page is held leaves its link pending.
  //
  // A start can reach the hook inside another flow's commit (an action's,
  // handed to React before the click's notification went out), whose
  // transition React may hold. There it shows through an optimistic value
  // set in that transition, as the loader's stream pin does
  // (loader-store.ts announcePendingStreams): urgent now, reverted with that
  // commit, never in a commit of its own.
  useEffect(() => {
    if (!ctx || linkTo === null) {
      return;
    }

    let last: NavigationEntry | null | undefined;
    const update = (signal?: RouteStateSignal) => {
      const navigation = visibleNavigation(ctx.eventController);
      if (navigation === last) return;
      last = navigation;
      const next = isPendingFor(linkTo, navigation, origin);
      setPending(next);
      if (next && signal === "anchor") show(true);
    };

    // Catch-up: re-read state synchronously on mount before subscribing, so a
    // navigation that started between the seeding render and this effect commit
    // isn't dropped until the next (debounced) notify. Mirrors usePathname /
    // useSearchParams.
    update();

    return ctx.eventController.subscribe(update);
  }, [linkTo, origin]);

  // If not inside a Link, return not pending
  if (linkTo === null) {
    return { pending: false };
  }

  return { pending: shown };
}
