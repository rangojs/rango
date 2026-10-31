"use client";

import { useLoader } from "@rangojs/router/client";
import { ciwDrawerAction } from "./cache-intercept-when.actions.js";
import { CiwDrawerLoader } from "./cache-intercept-when.defs.js";

export function CiwDrawerAction() {
  const { data } = useLoader(CiwDrawerLoader);
  return (
    <div>
      <span data-testid="ciw-drawer-runs">{data.runs}</span>
      <button
        data-testid="ciw-drawer-action"
        onClick={() => void ciwDrawerAction()}
      >
        Call action
      </button>
    </div>
  );
}
