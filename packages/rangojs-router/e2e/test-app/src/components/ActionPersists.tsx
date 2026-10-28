"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";
import {
  Link,
  useAction,
  useNavigation,
  usePathname,
} from "@rangojs/router/client";
import { actionPersistsSave } from "../actions/action-persists.js";

declare global {
  interface Window {
    /** Every commit of ActionPersistsChrome. */
    __actionPersistsLog?: {
      state: string;
      result: string;
      error: string;
      pathname: string;
    }[];
  }
}

const resultOf = (result: unknown): string =>
  typeof result === "string" ? result : "-";
const errorOf = (error: unknown): string => (error != null ? "error" : "-");

/**
 * The layout's chrome: a full-state useAction() reader, a selector for its
 * error, useNavigation() and usePathname() in one component. It logs every
 * commit to window.__actionPersistsLog. Each call of the save is labelled
 * "saved <n>".
 */
export function ActionPersistsChrome({ base }: { base: string }): ReactNode {
  const action = useAction(actionPersistsSave);
  const error = useAction(actionPersistsSave, (s) => errorOf(s.error));
  const nav = useNavigation((n) => n.state);
  const pathname = usePathname();
  const calls = useRef(0);
  const result = resultOf(action.result);

  useLayoutEffect(() => {
    (window.__actionPersistsLog ??= []).push({
      state: action.state,
      result,
      error,
      pathname,
    });
  });

  const call = (fail: boolean): void => {
    calls.current += 1;
    actionPersistsSave(`saved ${calls.current}`, fail).catch(() => {});
  };

  return (
    <header
      data-testid="action-persists-chrome"
      data-state={action.state}
      data-result={result}
      data-error={error}
      data-nav={nav}
    >
      <Link to={`${base}/a`} data-testid="action-persists-to-a">
        a
      </Link>
      <Link to={`${base}/b`} data-testid="action-persists-to-b">
        b
      </Link>
      <button
        type="button"
        data-testid="action-persists-save"
        onClick={() => call(false)}
      >
        save
      </button>
      <button
        type="button"
        data-testid="action-persists-fail"
        onClick={() => call(true)}
      >
        fail
      </button>
    </header>
  );
}

/** A reader by export name, mounted with each page. */
export function ActionPersistsPageReader({ id }: { id: string }): ReactNode {
  const result = useAction("actionPersistsSave", (s) => resultOf(s.result));
  const error = useAction("actionPersistsSave", (s) => errorOf(s.error));
  return (
    <p
      data-testid="action-persists-page-reader"
      data-page={id}
      data-result={result}
      data-error={error}
    >
      {result}
    </p>
  );
}
