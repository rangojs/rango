---
name: defer-hydration
description: Keep the full body HTML in a PPR shell's first paint while moving a heavy subtree's hydration off the initial main-thread task — a gated Suspense boundary with the content as its own fallback, released on first idle. Use when a shell HIT paints fast but one long hydration task blocks the main thread, TTI/INP is poor despite instant paint, or a plain Suspense boundary left an empty hole in the frozen prelude.
argument-hint:
---

# Deferred hydration: gated boundary, content-as-fallback

PPR (`/ppr`) makes first paint instant — the frozen prelude flushes before any
render work. It does nothing about what happens next: React hydrates the page
as one synchronous main-thread task, and on a content-heavy page that task can
block every click and scroll handler for seconds. Measured on a production
storefront homepage (shell HIT, production build, M-series laptop): a single
2543ms task. On the dev server the same page produced a 7.2s task — the page
was dead for ~11s. Fast paint, frozen page.

The obvious fix — wrap the heavy subtree in `<Suspense>` so it hydrates later —
trades the paint away: under shell capture that boundary postpones, and the
frozen prelude ships an empty `<main>`. This recipe gets both: the full body
HTML in the prelude AND its hydration off the initial task, released on first
idle at retry-lane priority.

|                                  | baseline | plain `fallback={null}` boundary | gated content-as-fallback |
| -------------------------------- | -------- | -------------------------------- | ------------------------- |
| body in first paint              | yes      | **no — empty `<main>`**          | yes                       |
| worst main-thread task           | 2543ms   | 844ms                            | **386ms**                 |
| total blocked time (>50ms tasks) | 2705ms   | 1436ms                           | **554ms**                 |
| interactive (menu click works)   | ~3.5s    | ~1.6s                            | ~1.6s                     |

Measure your own page before and after — the win depends on how much of the
hydration cost lives under the boundary (see "Verifying and measuring").

## The recipe

~40 lines, plain React, no rango imports — copy it into your app:

```tsx
"use client";
import type { ReactNode } from "react";
import { Suspense, startTransition, use, useEffect } from "react";

let released = false;
let releaseFn: (() => void) | undefined;
const gate = new Promise<void>((resolve) => {
  releaseFn = resolve;
});

function releaseHydrationGate() {
  if (released) return;
  released = true;
  // Transition so the boundary retry/hydration is scheduled non-urgent,
  // never as a sync flush from the idle callback.
  startTransition(() => releaseFn?.());
}

function HydrationGate() {
  // Server: inert (children SSR normally). Client before release: suspend,
  // so React skips hydrating the boundary and KEEPS the server DOM.
  if (typeof window !== "undefined" && !released) use(gate);
  return null;
}

function ReleaseHydrationGate() {
  // Sibling of the boundary — NEVER under it (its effect would deadlock
  // holding its own key). Hydrates with the early pass.
  useEffect(() => {
    if (released) return;
    if ("requestIdleCallback" in window) {
      requestIdleCallback(releaseHydrationGate, { timeout: 1500 });
    } else {
      setTimeout(releaseHydrationGate, 200);
    }
  }, []);
  return null;
}

export function DeferredHydration({ children }: { children: ReactNode }) {
  return (
    <>
      <ReleaseHydrationGate />
      <Suspense fallback={children}>
        <HydrationGate />
        {children}
      </Suspense>
    </>
  );
}
```

Wrap the heavy subtree — typically the page body under the app chrome:

```tsx
<DeferredHydration>
  <HomePageBody />
</DeferredHydration>
```

The chrome (header, nav — whatever must respond to the first click) stays
outside the boundary and hydrates in the early, now-small task. Everything
inside hydrates after first idle.

## Why `fallback={children}` is load-bearing

This is not a style choice; it is the half of the recipe that makes it
PPR-compatible.

Shell capture aborts on flight byte-quiet (`src/rsc/shell-capture.ts`,
`FLIGHT_QUIET_HOPS`): once the Flight source has been byte-silent for the
quiet window, the fizz render freezes. A big HTML subtree under _any_
`<Suspense>` boundary cannot finish inside that window, so the boundary always
postpones — boundary placement cannot fix it. Verified both ways: wrapping the
client island from outside AND placing the boundary inside the island both
baked `<!--$?--><template id="B:…">` into `<main>`, i.e. an empty body in the
frozen prelude.

With the content as the fallback, the unavoidable postpone _becomes the
delivery mechanism_: the shell bakes the fallback, and the fallback IS the
body. In `/ppr` hole-doctrine terms, this is the PHYSICS class exploited
deliberately — you cannot stop the boundary from becoming a hole, so you make
the hole's baked fallback carry the real markup.

## Why the client gate is free

Suspending during hydration keeps the **server DOM**, not the fallback. When
`HydrationGate` suspends on the client, React skips hydrating that boundary
and leaves the baked HTML in place — visible, styled, inert. On release, the
boundary retries on the retry lane (interruptible, non-urgent thanks to the
`startTransition` in `releaseHydrationGate`), and the existing DOM hydrates in
place. No blank, no flicker, no re-paint.

## The sync-update trap (scar tissue)

A **synchronous** update that reaches into a dehydrated boundary makes React
abandon hydration and client-render it instead. That client render suspends on
the gate and renders the fallback. With `fallback={children}` this is a visual
no-op (but wasted work); with `fallback={null}` it blanks the page.

The corollary: provider data syncs that land right after the chrome hydrates —
basket, wishlist, auth state read from storage in an effect — MUST be
`startTransition`-wrapped. This was measured, not theorized: without the
transitions, the boundary was force-hydrated synchronously and the split
evaporated (the 2543ms task survived intact).

```tsx
useEffect(() => {
  const stored = readBasketFromStorage();
  startTransition(() => setBasket(stored)); // NOT a bare setBasket(stored)
}, []);
```

## Pre-release interaction semantics

Between paint and release (window ≈ one idle, capped by the `requestIdleCallback`
timeout — 1500ms in the reference):

- **Native anchors work** — they are plain HTML in the server DOM, plus any
  click-delegation living above the boundary.
- **React `onClick`s inside the gated subtree queue** via React's event replay
  and fire on hydration after release.

If the gated subtree's first-click latency matters more than idle timing,
release on interaction instead (see Variations).

## Known cost: the body rides twice (measure it, don't guess)

On a shell HIT the gated subtree's HTML is in the response twice — once as the
baked fallback in the prelude, once as the resumed hole content (the resume
re-renders and re-ships it; there is no bake-through). Homepage measurement:
234KB → 302KB gzipped (+68KB, +29%; raw +1.05MB). It is post-paint bandwidth,
not render-blocking — the visible prelude streams first — but it is real bytes
on every document GET. Weigh it per page; on a small body the recipe may not
pay for itself.

## Verifying and measuring

Production build only — dev-server hydration numbers are noise (module
transforms dominate; the 7.2s dev task above vs 2543ms in production).

**Body in the prelude.** Fetch the document and check a distinctive piece of
body markup appears BEFORE the first resumed segment:

```
curl -s -H "Accept: text/html" http://localhost:4173/ \
  | awk '{ if (match($0, /<div hidden id="S:/)) { print substr($0, 1, RSTART); exit } print }' \
  | grep -c "Best Sellers"    # any string unique to the gated body
```

`0` with `<!--$?--><template id="B:` markers inside `<main>` means an empty
hole baked instead — the fallback is not the content (wrong boundary, or a
plain `fallback={null}`/skeleton boundary).

**Main-thread tasks.** Paste a longtask observer in the console before
reloading, then compare the worst task with the recipe on and off:

```js
new PerformanceObserver((l) =>
  l
    .getEntries()
    .forEach((e) => console.log("longtask", Math.round(e.duration))),
).observe({ entryTypes: ["longtask"] });
```

**Interactivity.** Click the chrome (menu, nav) immediately after paint — it
should respond while the gated body is still inert.

## Variations

- **Release on visible** — an `IntersectionObserver` per boundary instead of
  `requestIdleCallback`: below-the-fold sections hydrate only when scrolled
  near.
- **Release on first interaction** — a capture-phase listener
  (`pointerdown`/`keydown` on `window`) that releases immediately: the queued
  event replays into the touched boundary and React's selective hydration
  prioritizes it. Best when the gated subtree is itself the interaction
  target.
- **One shared gate vs per-boundary gates** — the reference uses one
  module-level gate (first release wins, all boundaries hydrate together).
  Multiple independent boundaries (visible-based, per-section) need one
  gate/`released` pair per boundary — factor the module into a
  `createHydrationGate()` if you go there.

## What this deliberately is not

The duplicated payload has an obvious framework-level fix: a "bake-through"
boundary that bakes the boundary _content_ into the prelude and skips the
redundant hole resume. That is deliberately NOT part of this recipe — a recipe
has zero API commitment, and React's `<Activity>`/postpone work may land under
this exact space. The recipe survives that future; a primitive might not.

## Related

- `/ppr` — the shell/hole mechanics this recipe rides on (hole doctrine:
  PHYSICS class), and why the capture postpones any big Suspense subtree
- `src/rsc/shell-capture.ts` — the byte-quiet capture window
  (`FLIGHT_QUIET_HOPS`) that makes `fallback={children}` mandatory
