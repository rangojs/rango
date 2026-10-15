"use client";

import type { ReactNode } from "react";
import { useLoader } from "@rangojs/router/client";
import { PprIncludeChromeLoader } from "../urls/ppr-include-bake.defs.js";

/**
 * Store chrome that reads the layout's `ssr: false` loader outside any
 * Suspense boundary (issue #1179): a capture that masked the loader
 * postponed above <body> and stored no shell.
 */
export function PprIncludeChrome({
  children,
}: {
  children: ReactNode;
}): React.ReactNode {
  const { data } = useLoader(PprIncludeChromeLoader);
  return (
    <div>
      <header data-testid="ppr-include-chrome">{data.run}</header>
      {children}
    </div>
  );
}
