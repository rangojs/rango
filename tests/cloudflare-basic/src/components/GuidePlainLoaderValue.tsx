"use client";

import { useLoader } from "@rangojs/router/client";
import { GuidePlainLoader } from "../loaders/guide-plain.js";

// Reads the fresh loader value via useLoader. The client reference lives in the
// frozen overlay payload, but the loader segment is resolved fresh per request
// (loaders are never pre-rendered), so gp-loader changes across overlay hits.
export function GuidePlainLoaderValue() {
  const { data } = useLoader(GuidePlainLoader);

  return <p data-testid="gp-loader">{data.value}</p>;
}
