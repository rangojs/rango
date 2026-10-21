"use client";

import { useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";
import type { PprGoneData } from "../loaders/ppr-gone.js";

export function PprGoneView({
  loader,
}: {
  loader: LoaderDefinition<PprGoneData>;
}) {
  const { data } = useLoader(loader);
  return <h1 data-testid="ppr-gone-name">{data.name}</h1>;
}
