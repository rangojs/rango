"use client";

import { useSearchParams } from "@rangojs/router/client";

// STATIC-part search read on a ppr route: this markup freezes into the shell
// prelude. Search is part of shell identity — the key embeds the sorted
// search and the capture/resume renders seed that SAME string
// (shellSearchSeed) — so the frozen value is per-shell-correct and hydration
// agrees with the browser URL on HITs.
export function ShellSearchProbe() {
  const [params] = useSearchParams();
  return (
    <div data-testid="shell-search-probe">
      {`filter:${params.get("filter") ?? "none"}`}
    </div>
  );
}
