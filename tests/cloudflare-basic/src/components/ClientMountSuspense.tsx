"use client";

import { use } from "react";

/**
 * Fully-prefetched commit-mode fixture (mirrors the router e2e app).
 *
 * A CLIENT component that starts its OWN suspending data request during its
 * FIRST client render — not a server promise, not a router loader, not an
 * effect (the suspension is pre-commit, so effects never run first) — with NO
 * <Suspense> of its own, so the suspension bubbles to the nearest router
 * boundary (the shared layout's loading() boundary). The server render is
 * immediate, so a hover prefetch drains fully (entry.complete -> fullyPrefetched).
 *
 * Contract pinned (#622 -> #624 -> reinstated transition): the fully-prefetched
 * nav commits inside startTransition, so the already-revealed layout boundary
 * HOLDS the previous child's content across this suspension instead of
 * revealing its fallback; the new content swaps in on resolve.
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
