"use client";

import type { ReactNode } from "react";
import { Component } from "react";
import { Link, useLoader, useSearchParams } from "@rangojs/router/client";
// The settled-lane fixture's loader, so this fixture adds no client
// reference: `?once` throws on its run's first call only.
import { SettledLaneFlakyLoader } from "./settled-lane-errors.loaders.js";

class AppBoundary extends Component<
  { children: ReactNode },
  { error: unknown }
> {
  state: { error: unknown } = { error: null };
  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error };
  }
  render(): ReactNode {
    if (this.state.error) {
      return <p data-testid="pre-app-boundary">loader failed</p>;
    }
    return this.props.children;
  }
}

function Stock(): ReactNode {
  const { data } = useLoader(SettledLaneFlakyLoader);
  return <p data-testid="pre-value">{data.value}</p>;
}

/** Reads the flaky loader inside the app's own error boundary. */
export function PrefetchRenderLoaderPage(): ReactNode {
  return (
    <AppBoundary>
      <Stock />
    </AppBoundary>
  );
}

const BASE = "/prefetch-render-errors";

/**
 * `pre-prefetch-*` links prefetch on hover and carry the page's `run`, so
 * each test has its own counters; `pre-link-home` never prefetches.
 */
export function PrefetchRenderNav(): ReactNode {
  const [search] = useSearchParams();
  const query = `?run=${search.get("run") ?? "none"}`;
  return (
    <nav>
      <Link to={`${BASE}/${query}`} prefetch="none" data-testid="pre-link-home">
        Home
      </Link>
      {["handler", "slow", "loader"].map((name) => (
        <Link
          key={name}
          to={`${BASE}/${name}${query}${name === "loader" ? "&once=1" : ""}`}
          prefetch="hover"
          data-testid={`pre-prefetch-${name}`}
        >
          {name}
        </Link>
      ))}
    </nav>
  );
}
