"use client";

import { useHandle } from "@rangojs/router/client";
import { PprWarnings } from "../loaders/ppr-shell.js";

/** One row per PprWarnings push, so a duplicated push renders twice. */
export function PprWarningsView() {
  const warnings = (useHandle(PprWarnings) ?? []).flat();
  return (
    <ul data-testid="ppr-warnings">
      {warnings.map((warning, index) => (
        <li key={index} data-testid="ppr-warning">
          {warning}
        </li>
      ))}
    </ul>
  );
}
