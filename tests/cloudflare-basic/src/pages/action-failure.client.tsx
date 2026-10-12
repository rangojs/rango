"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { useLoader, useSearchParams } from "@rangojs/router/client";
import {
  actionFailureSwitch,
  actionFailureSwitchForm,
} from "./action-failure.actions.js";
import {
  ActionFailureDataLoader,
  ActionFailureThrowLoader,
} from "./action-failure.defs.js";

// The draft is a form's React state; the outcome is what the action call
// resolved or rejected with.
function ActionFailureControls(): ReactNode {
  const [search] = useSearchParams();
  const run = search.get("run") ?? "none";
  const [draft, setDraft] = useState("");
  const [outcome, setOutcome] = useState("idle");
  const call = (fail: boolean): void => {
    setOutcome("pending");
    actionFailureSwitch(run, fail).then(
      (result) => setOutcome(`resolved:${result.saved}`),
      (error: unknown) =>
        setOutcome(
          `rejected:${error instanceof Error ? error.message : String(error)}`,
        ),
    );
  };
  return (
    <div>
      <input
        data-testid="af-draft"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <output data-testid="af-outcome">{outcome}</output>
      <button type="button" data-testid="af-fail" onClick={() => call(true)}>
        Fail loaders
      </button>
      <button
        type="button"
        data-testid="af-recover"
        onClick={() => call(false)}
      >
        Recover loaders
      </button>
      <form action={actionFailureSwitchForm}>
        <input type="hidden" name="run" value={run} />
        <input type="hidden" name="fail" value="true" />
        <button type="submit" data-testid="af-fail-form">
          Fail loaders (form action)
        </button>
      </form>
    </div>
  );
}

export function ActionFailureThrowPage(): ReactNode {
  const { data } = useLoader(ActionFailureThrowLoader);
  return (
    <div data-testid="af-page">
      <ActionFailureControls />
      <span data-testid="af-value">{data.value}</span>
    </div>
  );
}

export function ActionFailureDataPage(): ReactNode {
  const { data } = useLoader(ActionFailureDataLoader);
  return (
    <div data-testid="af-page">
      <ActionFailureControls />
      {data.ok ? (
        <span data-testid="af-value">{data.value}</span>
      ) : (
        <span data-testid="af-failure">{data.reason}</span>
      )}
    </div>
  );
}
