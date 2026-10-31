"use client";

import { useLoader } from "@rangojs/router/client";
import { iasDrawerAction } from "./intercept-action-select.actions.js";
import { IasDrawerLoader } from "./intercept-action-select.defs.js";

export function IasDrawerAction() {
  const { data } = useLoader(IasDrawerLoader);
  return (
    <div>
      <span data-testid="ias-drawer-runs">{data.runs}</span>
      <button
        data-testid="ias-drawer-action"
        onClick={() => void iasDrawerAction()}
      >
        Call action
      </button>
    </div>
  );
}
