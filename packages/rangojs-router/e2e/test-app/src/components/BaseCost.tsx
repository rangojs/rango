"use client";

import { useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router/client";

export function BaseCostValue({
  loader,
  testId,
}: {
  loader: LoaderDefinition<{ delay: number }>;
  testId: string;
}) {
  const { data } = useLoader(loader);
  return <span data-testid={testId}>{`v:${data.delay}`}</span>;
}
