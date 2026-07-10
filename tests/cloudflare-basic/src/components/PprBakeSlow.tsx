"use client";

import { useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";
import type { PprShellPriceData } from "../loaders/ppr-shell.js";

// Pin-first bake-lane view (loader-cache.ts `if (!recorded.holes)`). Renders the
// LAYOUT bake loader's pinned label beside the route's fast live price hole.
// Reading the layout loader from HERE (inside the route content, below the
// layout's Outlet) keeps the read within the layout's resolved LoaderBoundary
// context, so useLoader finds the layout loaderData. The bake label is frozen
// across HITs (snapshot pin); the price seq advances (live hole).
export function PprBakeSlow({
  bakeLoader,
  holeLoader,
}: {
  bakeLoader: LoaderDefinition<{ label: string }>;
  holeLoader: LoaderDefinition<PprShellPriceData>;
}) {
  const { data: bake } = useLoader(bakeLoader);
  const {
    data: { price, seq },
  } = useLoader(holeLoader);
  return (
    <>
      <span data-testid="ppr-bake-label">{bake.label}</span>
      <div data-testid="ppr-bake-price" data-seq={seq}>
        Live price: ${price} (seq {seq})
      </div>
    </>
  );
}
