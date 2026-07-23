"use client";

import { useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";

// Prerender+ppr composition consumer: renders the live loader's seq so the
// e2e can pin loader liveness (seq advances per HIT) straight from the
// streamed document body, while the surrounding prerendered tree replays.
export function PrerenderPprSeq({
  loader,
}: {
  loader: LoaderDefinition<{ seq: number }>;
}) {
  const { data } = useLoader(loader);
  return <p data-testid="pp-seq">{`pp-seq: ${data.seq}`}</p>;
}
