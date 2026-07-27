"use client";

import React from "react";
import {
  useParams,
  usePathname,
  useSearchParams,
  useNavigation,
  useRouter,
  useSegments,
  useHref,
} from "@rangojs/router/client";
import { useRenderTracker } from "../render-tracker.js";

// Hook render-stability probes.
//
// Each probe calls exactly one router hook and is wrapped in React.memo, so it
// re-renders ONLY when its own hook subscription emits a changed value — never
// merely because the page (its parent) re-renders. That isolation is what lets
// the e2e assert "an unrelated state change caused zero re-renders here".
//
// Selectors are module-level constants (stable identity) to avoid the
// inline-selector recompute path inside useParams/useNavigation/useSegments.

const selectId = (p: Record<string, string | undefined>) => p.id;
const selectNavState = (n: { state: string }) => n.state;
const selectPathLen = (s: { path: readonly string[] }) => s.path.length;

// useRouter returns a useMemo([]) stable instance with no store subscription, so
// this probe must NEVER re-render after mount, on any navigation.
export const RouterProbe = React.memo(function RouterProbe() {
  useRenderTracker("router");
  const router = useRouter();
  return <span data-testid="probe-router">router:{typeof router.push}</span>;
});

// useHref has no store subscription and returns a referentially stable function
// (memoized on the mount prefix), so this probe must NEVER re-render after mount
// on same-mount navigations. Referential stability itself is asserted at the
// unit level via renderRoute (a memoized probe can't observe it in e2e).
export const HrefProbe = React.memo(function HrefProbe() {
  useRenderTracker("href");
  const href = useHref();
  return <span data-testid="probe-href">href:{href("/")}</span>;
});

// usePathname re-renders only when the committed pathname changes.
export const PathnameProbe = React.memo(function PathnameProbe() {
  useRenderTracker("pathname");
  const pathname = usePathname();
  return <span data-testid="probe-pathname">path:{pathname}</span>;
});

// useParams(selectId) re-renders only when the selected param changes.
export const ParamsProbe = React.memo(function ParamsProbe() {
  useRenderTracker("params");
  const id = useParams(selectId);
  return <span data-testid="probe-params">id:{id ?? "none"}</span>;
});

// useSearchParams re-renders only when the committed search string changes.
export const SearchProbe = React.memo(function SearchProbe() {
  useRenderTracker("search");
  const [sp] = useSearchParams();
  return <span data-testid="probe-search">n:{sp.get("n") ?? "none"}</span>;
});

// useSegments(selectPathLen) re-renders only when the path segment count changes
// (a same-depth param swap keeps it stable).
export const SegmentsProbe = React.memo(function SegmentsProbe() {
  useRenderTracker("segments");
  const len = useSegments(selectPathLen);
  return <span data-testid="probe-segments">segments:{len}</span>;
});

// useNavigation(selectNavState) re-renders when the navigation state slice
// changes (idle -> loading/streaming -> idle during a navigation).
export const NavigationProbe = React.memo(function NavigationProbe() {
  useRenderTracker("navigation");
  const state = useNavigation(selectNavState);
  return <span data-testid="probe-navigation">state:{state}</span>;
});

function Probes() {
  return (
    <div data-testid="probes">
      <RouterProbe />
      <HrefProbe />
      <PathnameProbe />
      <ParamsProbe />
      <SearchProbe />
      <SegmentsProbe />
      <NavigationProbe />
    </div>
  );
}

function Controls({ onBumpLocal }: { onBumpLocal: () => void }) {
  const router = useRouter();
  // Read the current id so a search-only change keeps the same path.
  const id = useParams(selectId) ?? "1";
  const otherId = id === "1" ? "2" : "1";
  // Local counter to generate distinct search values per click.
  const [n, setN] = React.useState(0);

  return (
    <div data-testid="stability-controls">
      {/* Unrelated local state update in the page — must not re-render probes. */}
      <button data-testid="bump-local" onClick={onBumpLocal}>
        bump local
      </button>
      {/* Same path, changed search -> only the search probe should re-render. */}
      <button
        data-testid="change-search"
        onClick={() => {
          const next = n + 1;
          setN(next);
          router.push(`/render-stability/p/${id}?n=${next}`);
        }}
      >
        change search
      </button>
      {/* Different :id, no search -> params + pathname re-render; router/href do not. */}
      <button
        data-testid="change-param"
        onClick={() => router.push(`/render-stability/p/${otherId}`)}
      >
        change param
      </button>
    </div>
  );
}

/**
 * Render-stability harness page. Holds an unrelated local `tick` state; bumping
 * it re-renders this page but the memoized probes (no props, stable context)
 * must bail out. Probe render/commit counts are recorded on
 * window.__RANGO_RENDERS__ for the e2e to read.
 */
export function RenderStabilityPage() {
  const [tick, setTick] = React.useState(0);
  return (
    <div data-testid="render-stability-page">
      <span data-testid="page-tick">tick:{tick}</span>
      <Controls onBumpLocal={() => setTick((t) => t + 1)} />
      <Probes />
    </div>
  );
}
