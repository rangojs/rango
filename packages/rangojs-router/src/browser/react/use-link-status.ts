"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  type Context,
} from "react";
import { NavigationStoreContext } from "./context.js";
import type { EventController, NavigationEntry } from "../event-controller.js";

/**
 * What a Link hands to useLinkStatus: its resolved destination and an id for
 * this Link instance, which its click puts on the navigation (`_linkId`).
 */
export interface LinkTarget {
  readonly to: string;
  readonly id: string;
}

/**
 * Context for Link component to provide its destination and instance id.
 * Used by useLinkStatus to determine if this specific link is pending.
 */
export const LinkContext: Context<LinkTarget | null> =
  createContext<LinkTarget | null>(null);

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
 * Whether `navigation` is this link's. A Link's click names the link
 * (`_linkId`, kept through a server redirect chain), so only that link is
 * pending, not every link to the same URL. A navigation no Link started
 * (Back/Forward, router.push, an action's redirect) goes to every link to its
 * URL or, after a server redirect, to the URL its chain started from.
 */
function isPendingFor(
  link: LinkTarget | null,
  navigation: NavigationEntry | null,
  origin: string,
): boolean {
  if (link === null || !navigation) {
    return false;
  }
  const linkId = navigation.options?._linkId;
  if (linkId !== undefined) {
    return linkId === link.id;
  }
  const to = normalizeUrl(link.to, origin);
  const from = navigation.options?._redirectFrom;
  return (
    normalizeUrl(navigation.url, origin) === to ||
    (from !== undefined && normalizeUrl(from, origin) === to)
  );
}

/**
 * Hook to track the pending state of a Link component
 *
 * Must be used inside a Link component. Returns `{ pending: true }` while
 * this link's navigation is in flight, until the page it brings commits:
 * under transition() while React holds that page, and through a server
 * redirect until the target page commits. A click marks only the clicked
 * link; a navigation no link started (Back/Forward, router.push) marks every
 * link to its URL. A newer navigation ends it at once.
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
  const link = useContext(LinkContext);
  const ctx = useContext(NavigationStoreContext);

  const origin = ctx?.origin ?? "http://localhost";

  // The document renders no navigation in flight.
  const [pending, setPending] = useState<boolean>(
    () =>
      !!ctx &&
      !ctx.eventController.getHydrationSnapshot() &&
      isPendingFor(link, visibleNavigation(ctx.eventController), origin),
  );

  // The value commits in the lane of the notification that carries it, as
  // useNavigation's does: at once from the click's task, and with the page
  // when its commit clears the navigation (NavigationProvider flushes that
  // notification inside the page's update). Set once per navigation: a
  // repeated urgent set would commit ahead of a held page's settle. A
  // background navigation (an action's refetch) is not a newer one, so a
  // held link stays pending. Deps are the link's fields, not the object: a
  // provider's new object with the same fields must not resubscribe and set
  // the value again.
  useEffect(() => {
    if (!ctx || link === null) {
      return;
    }

    let last: NavigationEntry | null | undefined;
    const update = () => {
      const navigation = visibleNavigation(ctx.eventController);
      if (navigation === last) return;
      last = navigation;
      setPending(isPendingFor(link, navigation, origin));
    };

    // Catch-up: re-read state synchronously on mount before subscribing, so a
    // navigation that started between the seeding render and this effect commit
    // isn't dropped until the next (debounced) notify. Mirrors usePathname /
    // useSearchParams.
    update();

    return ctx.eventController.subscribe(update);
  }, [link?.to, link?.id, origin]);

  // If not inside a Link, return not pending
  if (link === null) {
    return { pending: false };
  }

  return { pending };
}
