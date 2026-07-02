"use client";

import { useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";
import type { PtSlowData } from "../loaders/pt-slow.js";

/**
 * Client component for /pt-slow: reads the slow loader via useLoader so the
 * loading() skeleton shows while data streams (cold) and the resolved data is
 * inlined with no flash on a fully-prefetched commit.
 */
export function PtSlowContent({
  loader,
}: {
  loader: LoaderDefinition<PtSlowData>;
}) {
  const {
    data: { message },
  } = useLoader(loader);
  return <div data-testid="pt-slow-message">{message}</div>;
}
