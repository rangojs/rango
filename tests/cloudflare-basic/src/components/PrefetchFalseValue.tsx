"use client";

import { useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router/client";

/**
 * Reads one /prefetch-false fixture loader (pages/prefetch-false.tsx) and
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
  return <span data-testid={testId}>{`${data.name}:${data.n}`}</span>;
}
