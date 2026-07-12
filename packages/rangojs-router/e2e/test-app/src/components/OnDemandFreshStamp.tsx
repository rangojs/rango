"use client";

import { useLoader, type LoaderDefinition } from "@rangojs/router/client";

interface FreshStampLoaderData {
  stamp: string;
}

interface OnDemandFreshStampProps {
  loader: LoaderDefinition<FreshStampLoaderData>;
}

// Displays the per-call-unique FreshStampLoader value. On an overlay
// (on-demand prerender) hit the frozen payload replays identically while this
// loader-backed stamp changes each request — the "loaders resolve fresh" proof.
export function OnDemandFreshStamp({ loader }: OnDemandFreshStampProps) {
  const { data } = useLoader<FreshStampLoaderData>(loader);
  return <p data-testid="od-plain-loader">{data.stamp}</p>;
}
