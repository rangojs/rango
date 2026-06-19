"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useOptimistic,
  startTransition,
  type Context,
} from "react";
import { NavigationStoreContext } from "./context.js";

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
 * Check if this link's destination matches the pending navigation URL
 */
function isPendingFor(
  linkTo: string | null,
  pendingUrl: string | null,
  origin: string,
): boolean {
  if (linkTo === null || pendingUrl === null) {
    return false;
  }
  return normalizeUrl(pendingUrl, origin) === normalizeUrl(linkTo, origin);
}

/**
 * Hook to track the pending state of a Link component
 *
 * Must be used inside a Link component. Returns `{ pending: true }`
 * when navigation to this link's destination is in progress.
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

  const origin =
    typeof window !== "undefined" ? window.location.origin : "http://localhost";

  const [basePending, setBasePending] = useState<boolean>(() => {
    if (!ctx || linkTo === null) {
      return false;
    }
    const state = ctx.eventController.getState();
    return isPendingFor(linkTo, state.pendingUrl, origin);
  });

  const prevPending = useRef(basePending);

  // Tracks whether the most recent setOptimisticPending call pinned the value
  // to a non-idle (loading) state. Used to decide whether to emit a release
  // update when returning to idle, so the optimistic store doesn't stay pinned
  // to `true` if a parent transition (e.g. the <Link> click / view transition
  // commit) is still pending. Mirrors useNavigation's optimisticPinnedRef.
  const optimisticPinnedRef = useRef(false);

  const [pending, setOptimisticPending] = useOptimistic(basePending);

  useEffect(() => {
    if (!ctx || linkTo === null) {
      return;
    }

    const update = () => {
      const state = ctx.eventController.getState();
      const isPending = isPendingFor(linkTo, state.pendingUrl, origin);

      if (isPending !== prevPending.current) {
        prevPending.current = isPending;

        const shouldPin = isPending && state.state !== "idle";

        if (shouldPin) {
          // Pin the optimistic value so the spinner shows immediately even if
          // a parent transition (e.g. <Link> click) defers the urgent
          // setBasePending commit.
          startTransition(() => {
            setOptimisticPending(isPending);
          });
          optimisticPinnedRef.current = true;
        } else if (optimisticPinnedRef.current) {
          // Release a previously-pinned optimistic value. Without this,
          // useOptimistic keeps returning the stale `true` while any parent
          // transition is still pending, even after basePending flipped to
          // false at navigation completion — leaving the link spinner stuck.
          startTransition(() => {
            setOptimisticPending(isPending);
          });
          optimisticPinnedRef.current = false;
        }

        // Always update base state
        setBasePending(isPending);
      }
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

  return { pending };
}
