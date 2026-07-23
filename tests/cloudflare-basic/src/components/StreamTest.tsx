"use client";

import { use } from "react";

/**
 * Streaming repro client component (mirrors the user's repro). A CLIENT
 * component that use()s a SERVER promise passed as a prop, sitting inside a
 * component-placed <Suspense> in the route handler. On a cold client
 * navigation the route streams: the <Suspense> fallback must show while this
 * promise resolves. In production this was being awaited to completion before
 * commit (no fallback); dev streamed correctly.
 */
export const StreamTest = ({ data }: { data: Promise<string> }) => {
  const value = use(data);
  return <div data-testid="stream-test-content">Test: {value}</div>;
};
