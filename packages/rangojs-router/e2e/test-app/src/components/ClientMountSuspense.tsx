"use client";

import { use } from "react";

/**
 * #622 follow-up (HIGH) regression component.
 *
 * A CLIENT component that starts its OWN suspending data request only when it
 * MOUNTS (post-commit) — NOT a promise passed from the server, and NOT a router
 * loader, and with NO <Suspense> of its own. The server/RSC render of this route
 * completes immediately (the client component is just a reference during
 * prefetch), so a hover prefetch's stream drains fully and the entry is
 * `complete` (fullyPrefetched).
 *
 * The route wraps this in a loading() skeleton (a router-level Suspense). Because
 * the client component has no boundary of its own, its post-mount suspension
 * bubbles to that loading() boundary.
 *
 * The bug this guards: a fully-prefetched nav used to commit inside
 * startTransition, which holds the OLD page until ALL suspense in the new tree
 * settles — including this client-initiated mount suspense — so the previous page
 * was retained for the whole delay with NO visible feedback. The fix commits
 * normally (router loaders/content forceAwait-ed, no flash for ROUTER data), so
 * this client suspense reveals the route's fallback instead of holding the old
 * page.
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

// No <Suspense> here: the post-mount suspension bubbles to the route's loading()
// boundary, which is the boundary the old startTransition behavior would hold.
export function ClientMountSuspense() {
  const value = use(getMountPromise());
  return <div data-testid="client-suspense-content">{value}</div>;
}
