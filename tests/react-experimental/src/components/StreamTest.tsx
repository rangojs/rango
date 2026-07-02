"use client";

import { use } from "react";

// Streaming repro client component (mirrors the user's repro): a CLIENT
// component that use()s a SERVER promise passed as a prop, inside a
// component-placed <Suspense> in the route handler. On a cold client nav the
// route must stream — the <Suspense> fallback shows while this resolves.
export const StreamTest = ({ data }: { data: Promise<string> }) => {
  const value = use(data);
  return <div data-testid="stream-test-content">Test: {value}</div>;
};
