"use client";

import { useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";

// Prerender+ppr composition consumer: renders the live slot loader's seq so
// the e2e can pin loader liveness (seq advances per HIT) straight from the
// streamed document body, while the prerendered tree replays around it.
export function PprPrerenderSeq({
  loader,
}: {
  loader: LoaderDefinition<{ seq: number }>;
}) {
  const { data } = useLoader(loader);
  return <p data-testid="ppr-pp-seq">{`ppr-pp-seq: ${data.seq}`}</p>;
}
