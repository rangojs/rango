"use client";

import type { ReactNode } from "react";
import { Component, useState } from "react";
import { Link, useLoader, useSearchParams } from "@rangojs/router/client";
import { settledLaneBreak } from "./settled-lane-errors.actions.js";
import {
  SettledLaneFailLoader,
  SettledLaneFlakyLoader,
  SettledLaneGoneLoader,
} from "./settled-lane-errors.loaders.js";

class AppBoundary extends Component<
  { children: ReactNode },
  { error: unknown }
> {
  state: { error: unknown } = { error: null };
  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error };
  }
  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      return (
        <p data-testid="sle-app-boundary">
          {error instanceof Error ? error.message : String(error)}
        </p>
      );
    }
    return this.props.children;
  }
}

function Stock(): ReactNode {
  const { data } = useLoader(SettledLaneFailLoader);
  return <p data-testid="sle-value">{data.value}</p>;
}

/** Reads the failing loader inside the app's own error boundary. */
export function SettledLaneFailPage(): ReactNode {
  return (
    <article data-testid="sle-fail-page">
      <AppBoundary>
        <Stock />
      </AppBoundary>
    </article>
  );
}

function FlakyStock(): ReactNode {
  const { data } = useLoader(SettledLaneFlakyLoader);
  return <p data-testid="sle-flaky-value">{data.value}</p>;
}

/** Reads the flaky loader inside the app's own error boundary. */
export function SettledLaneFlakyPage(): ReactNode {
  return (
    <article data-testid="sle-flaky-page">
      <AppBoundary>
        <FlakyStock />
      </AppBoundary>
    </article>
  );
}

export function SettledLaneGonePage(): ReactNode {
  const { data } = useLoader(SettledLaneGoneLoader);
  return <p data-testid="sle-gone">{data.name}</p>;
}

const BASE = "/settled-lane-errors";

/**
 * `sle-prefetch-*` links prefetch on hover (the test waits for the prefetch to
 * drain, then clicks: a fully-prefetched click); `sle-link-*` never prefetch.
 * The page's `run` search param rides on the ok and flaky links, and the
 * break button switches that run's flaky loader to throw.
 */
export function SettledLaneNav(): ReactNode {
  const [search] = useSearchParams();
  const run = search.get("run");
  const query = run ? `?run=${run}` : "";
  const [outcome, setOutcome] = useState("idle");
  return (
    <nav>
      <Link to={`${BASE}/ok${query}`} prefetch="none" data-testid="sle-link-ok">
        Ok
      </Link>
      <Link
        to={`${BASE}/flaky${query}`}
        prefetch="none"
        data-testid="sle-link-flaky"
      >
        Flaky
      </Link>
      <button
        type="button"
        data-testid="sle-break"
        onClick={() => void settledLaneBreak(run ?? "none").then(setOutcome)}
      >
        Break the flaky loader
      </button>
      <output data-testid="sle-break-outcome">{outcome}</output>
      <Link to={`${BASE}/fail`} prefetch="none" data-testid="sle-link-fail">
        Fail
      </Link>
      <Link
        to={`${BASE}/fail-loading`}
        prefetch="none"
        data-testid="sle-link-fail-loading"
      >
        Fail with loading()
      </Link>
      <Link
        to={`${BASE}/fail`}
        prefetch="hover"
        data-testid="sle-prefetch-fail"
      >
        Fail (prefetched)
      </Link>
      <Link
        to={`${BASE}/fail-loading`}
        prefetch="hover"
        data-testid="sle-prefetch-fail-loading"
      >
        Fail with loading() (prefetched)
      </Link>
      <Link
        to={`${BASE}/gone`}
        prefetch="hover"
        data-testid="sle-prefetch-gone"
      >
        Gone (prefetched)
      </Link>
    </nav>
  );
}
