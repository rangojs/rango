"use client";

import { useLoader } from "@rangojs/router/client";
import { CfPhgHoleLoader } from "../loaders/ppr-header-guard.js";

// The live hole for the ppr-header-guard mw-live/basket shells: suspends on
// the loader, so the boundary postpones at capture and resumes per request.
export function CfPhgHole() {
  const {
    data: { seq },
  } = useLoader(CfPhgHoleLoader);
  return <span data-testid="cf-phg-hole-seq">{seq}</span>;
}
