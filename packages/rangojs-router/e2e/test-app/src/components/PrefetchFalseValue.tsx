"use client";

import { useLoader, useNavigation } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router/client";

/**
 * Reads one /prefetch-false fixture loader (urls/prefetch-false.tsx) and
 * prints `<counter name>:<run number>`, so a suite sees both that the value
 * arrived and which server run produced it.
 */
export function PrefetchFalseValue({
  loader,
  testId,
}: {
  loader: LoaderDefinition<{ name: string; n: number }>;
  testId: string;
}) {
  const { data } = useLoader(loader);
  return (
    <span
      style={{
        display: "inline-block",
        margin: "4px 8px 4px 0",
        padding: "4px 10px",
        border: "1px solid #2e9e5b",
        borderRadius: 4,
        background: "rgba(46,158,91,0.15)",
      }}
    >
      <span style={{ opacity: 0.7, marginRight: 8, fontSize: 12 }}>loaded</span>
      <span data-testid={testId}>{`${data.name}:${data.n}`}</span>
    </span>
  );
}

/**
 * useNavigation() as attributes, for a suite to read while a fill is in
 * flight: data-state and data-streaming. Not visible.
 */
export function PrefetchFalseNav() {
  const nav = useNavigation();
  return (
    <span
      data-testid="pf-nav"
      data-state={nav.state}
      data-streaming={String(nav.isStreaming)}
      hidden
    />
  );
}
