"use client";

import { useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";

// Consumer for the identity-guard negative: renders the bake-lane identity
// loader's per-user value on axis 1. Never reaches a shell — the capture
// refuses when the loader's cookies() read trips the guard.
export function ShellGuardValue({
  loader,
}: {
  loader: LoaderDefinition<string>;
}) {
  const { data } = useLoader(loader);
  return <span data-testid="shell-guard-value">{data}</span>;
}
