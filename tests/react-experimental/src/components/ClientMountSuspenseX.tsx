"use client";

import { Suspense, use } from "react";
import { usePathname } from "@rangojs/router/client";

/**
 * Fully-prefetched commit-mode fixtures on EXPERIMENTAL React (mirrors
 * ClientMountSuspense / ClientMountSuspenseBounded in the router e2e app and
 * cloudflare-basic): a client component that creates-and-caches a suspending
 * promise during its FIRST render, in two variants:
 *
 *  - XcsBare    : no <Suspense> of its own — the suspension bubbles to the
 *                 layout's already-revealed loading() boundary, which the warm
 *                 startTransition commit HOLDS (old page stays, no fallback).
 *  - XcsBounded : ships its OWN <Suspense> — newly mounted by the nav, so its
 *                 LOCAL fallback is revealed immediately even inside the
 *                 transition (a transition only waits to avoid hiding
 *                 already-revealed content).
 *
 * Experimental React is the runtime where addTransitionType/<ViewTransition>
 * are live; the bare warm-hit commit uses neither, and the e2e additionally
 * pins that no document.startViewTransition fires for these navs.
 */

const CLIENT_MOUNT_DELAY = 1500;

let barePromise: Promise<string> | null = null;
function getBarePromise(): Promise<string> {
  if (!barePromise) {
    barePromise = new Promise<string>((resolve) =>
      setTimeout(() => resolve("client-mounted"), CLIENT_MOUNT_DELAY),
    );
  }
  return barePromise;
}

let boundedPromise: Promise<string> | null = null;
function getBoundedPromise(): Promise<string> {
  if (!boundedPromise) {
    boundedPromise = new Promise<string>((resolve) =>
      setTimeout(() => resolve("client-mounted-bounded"), CLIENT_MOUNT_DELAY),
    );
  }
  return boundedPromise;
}

export function XcsPathnameProbe() {
  const pathname = usePathname();
  return <output data-testid="xcs-pathname">{pathname}</output>;
}

export function XcsBare() {
  (
    window as unknown as { __rangoClientSuspenseStarted?: boolean }
  ).__rangoClientSuspenseStarted = true;
  const value = use(getBarePromise());
  return <div data-testid="xcs-content">{value}</div>;
}

function BoundedInner() {
  const value = use(getBoundedPromise());
  return <div data-testid="xcs-bounded-content">{value}</div>;
}

export function XcsBounded() {
  return (
    <Suspense
      fallback={<div data-testid="xcs-local-fallback">local-loading</div>}
    >
      <BoundedInner />
    </Suspense>
  );
}
