"use client";

import { Suspense, use } from "react";

/**
 * Escape-hatch counterpart to ClientMountSuspense (mirrors the router e2e
 * app): the SAME create-on-first-render suspense-cache pattern, but the
 * component ships its OWN <Suspense> boundary. That boundary is newly mounted
 * by the navigation, and React reveals newly mounted boundaries' fallbacks
 * even inside a transition (a transition only waits to avoid hiding
 * already-revealed content) — so a fully-prefetched startTransition commit
 * shows the LOCAL fallback right away instead of holding the old page at the
 * layout boundary.
 */

const CLIENT_MOUNT_DELAY = 1500;

let mountPromise: Promise<string> | null = null;
function getMountPromise(): Promise<string> {
  if (!mountPromise) {
    mountPromise = new Promise<string>((resolve) =>
      setTimeout(() => resolve("client-mounted-bounded"), CLIENT_MOUNT_DELAY),
    );
  }
  return mountPromise;
}

function Inner() {
  const value = use(getMountPromise());
  return <div data-testid="cf-cs-bounded-content">{value}</div>;
}

export function ClientMountSuspenseBounded() {
  return (
    <Suspense
      fallback={<div data-testid="pt-local-fallback">local-loading</div>}
    >
      <Inner />
    </Suspense>
  );
}
