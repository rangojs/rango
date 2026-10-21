"use client";

import { useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";
import type { ShellGoneData } from "../urls/shell-cache-gone.js";

export function ShellGoneView({
  loader,
}: {
  loader: LoaderDefinition<ShellGoneData>;
}) {
  const { data } = useLoader(loader);
  return <h1 data-testid="shell-gone-name">{data.name}</h1>;
}
