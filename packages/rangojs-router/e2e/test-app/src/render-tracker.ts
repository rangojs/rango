// Global render/commit tracker for the hook render-stability e2e.
//
// Installed on window.__RANGO_RENDERS__ so Playwright can read exact per-label
// counts via page.evaluate. Two signals are recorded:
//
//   renders[label] - bumped in the component body, so it runs on every
//     render-function invocation. Under React.StrictMode (development) the body
//     runs twice, so this doubles. That doubling is exactly what the non-strict
//     test variant (createRouter({ strictMode: false })) isolates away.
//
//   commits[label] - bumped in a no-deps useEffect, so it runs once per
//     committed render. StrictMode doubles only the initial mount (setup,
//     cleanup, setup); updates run once. So commit deltas across an interaction
//     are StrictMode-invariant and good for "did this re-render" assertions.
//
// The body bump is an intentional render-phase side effect: it never affects
// rendered output, so it cannot cause a hydration mismatch.

import { useEffect } from "react";

export interface RenderTrackerSnapshot {
  renders: Record<string, number>;
  commits: Record<string, number>;
}

export interface RenderTracker {
  renders: Record<string, number>;
  commits: Record<string, number>;
  bumpRender(label: string): void;
  bumpCommit(label: string): void;
  reset(): void;
  snapshot(): RenderTrackerSnapshot;
}

declare global {
  interface Window {
    __RANGO_RENDERS__?: RenderTracker;
  }
}

const KEY = "__RANGO_RENDERS__";

function createTracker(): RenderTracker {
  const renders: Record<string, number> = {};
  const commits: Record<string, number> = {};
  return {
    renders,
    commits,
    bumpRender(label) {
      renders[label] = (renders[label] ?? 0) + 1;
    },
    bumpCommit(label) {
      commits[label] = (commits[label] ?? 0) + 1;
    },
    reset() {
      for (const k of Object.keys(renders)) delete renders[k];
      for (const k of Object.keys(commits)) delete commits[k];
    },
    snapshot() {
      return { renders: { ...renders }, commits: { ...commits } };
    },
  };
}

function getTracker(): RenderTracker {
  const w = globalThis as typeof globalThis & {
    __RANGO_RENDERS__?: RenderTracker;
  };
  let tracker = w[KEY];
  if (!tracker) {
    tracker = createTracker();
    w[KEY] = tracker;
  }
  return tracker;
}

/**
 * Track a labeled component's render-phase invocations and committed renders.
 * Call once at the top of a "use client" component body.
 */
export function useRenderTracker(label: string): void {
  // Render-phase bump: runs on every render-function invocation (doubles under
  // StrictMode in development).
  getTracker().bumpRender(label);
  // Commit bump: runs once per committed render. The mount runs twice under
  // StrictMode; updates run once.
  useEffect(() => {
    getTracker().bumpCommit(label);
  });
}
