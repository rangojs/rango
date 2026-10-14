"use client";

import { useActionState, ViewTransition } from "react";
import { transitionKindsAction } from "../actions/transition-kinds.js";

/**
 * #1165 probe: records the transition types of each commit that animates it
 * (window.__vtKinds, "<event>:<types>"). "log" has no class map, so every
 * transition commit that changes its stamp animates it. "push" and "legacy"
 * resolve "none" unless a type their map keys is on the commit.
 */
export type TransitionKindsProbeKind = "log" | "push" | "legacy";

const MAPS = {
  push: { push: "vt-kinds-push", default: "none" },
  legacy: { navigation: "vt-kinds-nav", default: "none" },
};

function record(event: string) {
  return (_instance: unknown, types: readonly string[]): void => {
    const w = window as unknown as { __vtKinds?: string[] };
    (w.__vtKinds ??= []).push(`${event}:${types.join(",")}`);
  };
}

export function TransitionKindsProbe({
  probe,
  stamp,
}: {
  probe: TransitionKindsProbeKind;
  stamp: string;
}) {
  return (
    <ViewTransition
      default={probe === "log" ? undefined : MAPS[probe]}
      onEnter={record("enter")}
      onUpdate={record("update")}
    >
      <span data-testid="vt-kinds-stamp">{stamp}</span>
    </ViewTransition>
  );
}

export function TransitionKindsAction() {
  const [count, run] = useActionState(transitionKindsAction, 0);
  return (
    <form action={run}>
      <button type="submit" data-testid="vt-kinds-action">
        {`actions:${count}`}
      </button>
    </form>
  );
}
