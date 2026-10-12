"use client";

import type { ReactNode } from "react";
import { Component, useEffect, useState } from "react";
import {
  Link,
  useAction,
  useLoader,
  useParams,
  usePathname,
  useSearchParams,
} from "@rangojs/router/client";
import {
  actionFailureDeleteItem,
  actionFailureSlow,
  actionFailureSwitch,
  actionFailureSwitchForm,
} from "./action-failure.actions.js";
import {
  ActionFailureDataLoader,
  ActionFailureRevisionLoader,
  ActionFailureThrowLoader,
} from "./action-failure.defs.js";
import { ActionFailureItemLoader } from "./action-failure.item-loader.js";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// What an action call resolved or rejected with, also written to
// <html data-af-outcome> so it stays readable after the page unmounts.
function useOutcome(): [string, (saved: Promise<string>) => void] {
  const [outcome, setOutcome] = useState("idle");
  const report = (value: string): void => {
    document.documentElement.dataset.afOutcome = value;
    setOutcome(value);
  };
  const settle = (saved: Promise<string>): void => {
    report("pending");
    saved.then(
      (value) => report(`resolved:${value}`),
      (error: unknown) => report(`rejected:${message(error)}`),
    );
  };
  return [outcome, settle];
}

// The draft is a form's React state. The revalidation line keeps the last
// useAction `revalidationError` either action reported (useAction drops it
// once the action has settled), the slow line the slow action's. The reload
// link navigates to the page's own URL. The concurrent button calls the
// switch and the slow action together.
function ActionFailureControls(): ReactNode {
  const [search] = useSearchParams();
  const pathname = usePathname();
  const run = search.get("run") ?? "none";
  const [draft, setDraft] = useState("");
  const [outcome, settle] = useOutcome();
  const [revalidation, setRevalidation] = useState("none");
  const [slowRevalidation, setSlowRevalidation] = useState("none");
  const callFailure = useAction(actionFailureSwitch).revalidationError;
  const formFailure = useAction(actionFailureSwitchForm).revalidationError;
  const slowFailure = useAction(actionFailureSlow).revalidationError;
  useEffect(() => {
    const failure = callFailure ?? formFailure;
    if (failure != null) setRevalidation(message(failure));
  }, [callFailure, formFailure]);
  useEffect(() => {
    if (slowFailure != null) setSlowRevalidation(message(slowFailure));
  }, [slowFailure]);
  const call = (fail: boolean): void =>
    settle(actionFailureSwitch(run, fail).then((result) => result.saved));
  const callConcurrent = (): void =>
    settle(
      Promise.all([
        actionFailureSwitch(run, "always"),
        actionFailureSlow(),
      ]).then(([fast, slow]) => `${fast.saved},${slow.saved}`),
    );
  return (
    <div>
      <input
        data-testid="af-draft"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <output data-testid="af-outcome">{outcome}</output>
      <output data-testid="af-revalidation-error">{revalidation}</output>
      <output data-testid="af-slow-revalidation-error">
        {slowRevalidation}
      </output>
      <Link
        to={`${pathname}?${search.toString()}`}
        prefetch="none"
        data-testid="af-reload"
      >
        Reload this page
      </Link>
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
      <button
        type="button"
        data-testid="af-fail-concurrent"
        onClick={callConcurrent}
      >
        Fail loaders from two actions at once
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

/**
 * The app's own error boundary around the stock read. `resetKey` is the
 * revision loader's value, read outside it: a rerun that succeeds clears the
 * error in the render that brings the new stock data.
 */
class ActionFailureAppBoundary extends Component<
  { children: ReactNode; resetKey: number },
  { error: unknown; resetKey: number }
> {
  state: { error: unknown; resetKey: number } = {
    error: null,
    resetKey: this.props.resetKey,
  };

  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error };
  }

  static getDerivedStateFromProps(
    props: { resetKey: number },
    state: { resetKey: number },
  ): { error: null; resetKey: number } | null {
    return props.resetKey !== state.resetKey
      ? { error: null, resetKey: props.resetKey }
      : null;
  }

  render(): ReactNode {
    if (this.state.error) {
      return <p data-testid="af-app-boundary">{message(this.state.error)}</p>;
    }
    return this.props.children;
  }
}

function ActionFailureStock(): ReactNode {
  const { data } = useLoader(ActionFailureThrowLoader);
  return <span data-testid="af-value">{data.value}</span>;
}

/**
 * The stock read sits in the app's boundary, next to the controls, so a
 * failure replaces only the read. With `bare` in the URL it has none: the
 * route's errorBoundary(), or the router's root boundary, catches it.
 */
export function ActionFailureThrowPage(): ReactNode {
  const [search] = useSearchParams();
  const { data: revision } = useLoader(ActionFailureRevisionLoader);
  return (
    <div data-testid="af-page">
      <ActionFailureControls />
      {search.has("bare") ? (
        <ActionFailureStock />
      ) : (
        <ActionFailureAppBoundary resetKey={revision}>
          <ActionFailureStock />
        </ActionFailureAppBoundary>
      )}
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

export function ActionFailureLoading(): ReactNode {
  return <p data-testid="af-loading">Loading the page</p>;
}

/**
 * Controls of the layout above the group's errorBoundary() mount: they stay
 * when the boundary's fallback replaces the group. `af-bounded-recover`
 * turns the run's switch off and reruns the loader; `af-bounded-fail-nav`
 * navigates within the group to a new run whose first loader run throws.
 */
export function ActionFailureBoundedControls(): ReactNode {
  const [search] = useSearchParams();
  const pathname = usePathname();
  const run = search.get("run") ?? "none";
  const [draft, setDraft] = useState("");
  const [outcome, settle] = useOutcome();
  return (
    <div data-testid="af-bounded-controls">
      <input
        data-testid="af-bounded-draft"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <output data-testid="af-bounded-outcome">{outcome}</output>
      <button
        type="button"
        data-testid="af-bounded-recover"
        onClick={() =>
          settle(actionFailureSwitch(run, false).then((r) => r.saved))
        }
      >
        Recover loaders
      </button>
      <Link
        to={`${pathname}?bare&run=${run}-nav&fail-first`}
        prefetch="none"
        data-testid="af-bounded-fail-nav"
      >
        Navigate to a run that fails
      </Link>
    </div>
  );
}

/** An item with a delete action; its loader redirects once it is gone. */
export function ActionFailureItemPage(): ReactNode {
  const { data } = useLoader(ActionFailureItemLoader);
  const { id = "" } = useParams();
  const [search] = useSearchParams();
  const [outcome, settle] = useOutcome();
  return (
    <div data-testid="af-item">
      <span data-testid="af-item-name">{data.name}</span>
      <button
        type="button"
        data-testid="af-item-delete"
        onClick={() =>
          settle(
            actionFailureDeleteItem(search.get("run") ?? "none", id).then(
              (result) => result.deleted,
            ),
          )
        }
      >
        Delete
      </button>
      <output data-testid="af-item-outcome">{outcome}</output>
    </div>
  );
}

export function ActionFailureItemsPage(): ReactNode {
  return <p data-testid="af-items">The item list</p>;
}
