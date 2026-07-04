"use client";

import { useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";

// Slot-owned consumer for the slot-hole fixture. Reads the badge loader the
// @badge parallel slot registers; the slot's own LoaderBoundary is the Suspense
// boundary the capture postpones at, so this renders the frozen fallback in the
// prelude and the live value in the resumed tail.
export function ShellBadge({ loader }: { loader: LoaderDefinition<string> }) {
  const { data } = useLoader(loader);
  return <span data-testid="shell-badge-value">{data}</span>;
}
