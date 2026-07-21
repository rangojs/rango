"use client";

import { use } from "react";
import { usePathname } from "@rangojs/router/client";

/**
 * Fully-prefetched commit-mode fixture component.
 *
 * A CLIENT component that starts its OWN suspending data request during its
 * FIRST client render — NOT a promise passed from the server, NOT a router
 * loader, no <Suspense> of its own, and not an effect (the suspension happens
 * pre-commit, so effects never get to run first). The server/RSC render of this
 * route completes immediately (the client component is just a reference during
 * prefetch), so a hover prefetch's stream drains fully and the entry is
 * `complete` (fullyPrefetched).
 *
 * Because the component has no boundary of its own, its suspension bubbles to
 * the layout's already-revealed loading() boundary. The contract this pins
 * (#622 -> #624 -> reinstated transition): a fully-prefetched nav commits
 * inside startTransition, so that boundary HOLDS the previous page's content
 * across this suspension instead of flashing the fallback; the new content
 * swaps in when the promise resolves.
 */

const CLIENT_MOUNT_DELAY = 1500;

// Created lazily on first client render (mount), so the promise does not exist
// during the server/prefetch render — it is a genuine post-mount data request.
let mountPromise: Promise<string> | null = null;
function getMountPromise(): Promise<string> {
  if (!mountPromise) {
    mountPromise = new Promise<string>((resolve) =>
      setTimeout(() => resolve("client-mounted"), CLIENT_MOUNT_DELAY),
    );
  }
  return mountPromise;
}

export function ClientPathnameProbe() {
  const pathname = usePathname();
  return <output data-testid="cs-pathname">{pathname}</output>;
}

// No <Suspense> here: the post-mount suspension bubbles to the route's loading()
// boundary, which is the boundary the old startTransition behavior would hold.
export function ClientMountSuspense() {
  (
    window as unknown as { __rangoClientSuspenseStarted?: boolean }
  ).__rangoClientSuspenseStarted = true;
  const value = use(getMountPromise());
  return <div data-testid="client-suspense-content">{value}</div>;
}
