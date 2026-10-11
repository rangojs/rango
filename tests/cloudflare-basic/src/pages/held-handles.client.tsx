"use client";

import { useHandle, useLoader } from "@rangojs/router/client";
import {
  heldHandlesTargetAction,
  heldHandlesToggleAction,
} from "./held-handles.actions.js";
import {
  HeldCrumbs,
  HeldHandlesHeldLoader,
  HeldHandlesRerunLoader,
} from "./held-handles.defs.js";

export function HeldHandlesCrumbs() {
  const crumbs = useHandle(HeldCrumbs) ?? [];
  return (
    <ul data-testid="hh-crumbs">
      {crumbs.map((crumb, index) => (
        <li key={index} data-testid="hh-crumb">
          {crumb}
        </li>
      ))}
    </ul>
  );
}

export function HeldHandlesActionsBar() {
  return (
    <div>
      <button
        data-testid="hh-toggle"
        onClick={() => void heldHandlesToggleAction()}
      >
        Toggle
      </button>
      <button
        data-testid="hh-target"
        onClick={() => void heldHandlesTargetAction()}
      >
        Target
      </button>
    </div>
  );
}

export function HeldHandlesView() {
  const { data: held } = useLoader(HeldHandlesHeldLoader);
  const { data: rerun } = useLoader(HeldHandlesRerunLoader);
  return (
    <div data-testid="hh-view">
      <span data-testid="hh-held-runs">{held.runs}</span>
      <span data-testid="hh-rerun-runs">{rerun.runs}</span>
    </div>
  );
}
