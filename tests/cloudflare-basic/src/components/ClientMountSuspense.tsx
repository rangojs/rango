"use client";

import { use } from "react";

/**
 * #622 follow-up (HIGH) regression component (mirrors the router e2e app).
 *
 * A CLIENT component that starts its OWN suspending data request only when it
 * MOUNTS (post-commit) — not a server promise, not a router loader — and with NO
 * <Suspense> of its own, so its post-mount suspension bubbles to the nearest
 * router boundary (the shared layout's loading() boundary). The server render is
 * immediate, so a hover prefetch drains fully (entry.complete -> fullyPrefetched).
 *
 * A fully-prefetched nav used to commit inside startTransition, which held the
 * previous child's content at the persistent layout boundary until this client
 * mount-suspense settled (old page retained, no feedback). The fix commits
 * normally, so the boundary reveals its loading() fallback instead.
 */

const CLIENT_MOUNT_DELAY = 1500;

let mountPromise: Promise<string> | null = null;
function getMountPromise(): Promise<string> {
  if (!mountPromise) {
    mountPromise = new Promise<string>((resolve) =>
      setTimeout(() => resolve("client-mounted"), CLIENT_MOUNT_DELAY),
    );
  }
  return mountPromise;
}

export function ClientMountSuspense() {
  const value = use(getMountPromise());
  return <div data-testid="cf-cs-content">{value}</div>;
}
