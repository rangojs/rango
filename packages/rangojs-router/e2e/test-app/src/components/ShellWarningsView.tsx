"use client";

import { useHandle } from "@rangojs/router/client";
import { ShellWarnings } from "../urls/shell-cache.defs.js";

/** One row per ShellWarnings push, so a duplicated push renders twice. */
export function ShellWarningsView() {
  const warnings = (useHandle(ShellWarnings) ?? []).flat();
  return (
    <ul data-testid="shell-warnings">
      {warnings.map((warning, index) => (
        <li key={index} data-testid="shell-warning">
          {warning}
        </li>
      ))}
    </ul>
  );
}
