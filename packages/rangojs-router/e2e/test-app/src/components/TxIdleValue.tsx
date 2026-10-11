"use client";

import { useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router/client";

/** Reads one loader under the route's loading() boundary (/tx-idle/*). */
export function TxIdleValue({
  loader,
  testId,
}: {
  loader: LoaderDefinition<{ delay: number }>;
  testId: string;
}) {
  const { data } = useLoader(loader);
  return <span data-testid={testId}>{`v:${data.delay}`}</span>;
}
