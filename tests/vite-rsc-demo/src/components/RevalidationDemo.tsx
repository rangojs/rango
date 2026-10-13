"use client";

import { Component, useEffect, useState, type ReactNode } from "react";
import { useAction, useLoader } from "@rangojs/router/client";
import {
  SaveStatusLoader,
  StockFailureFlagLoader,
  StockLoader,
} from "@/handlers/errors-revalidation/loaders.js";
import {
  saveNote,
  setStockRefreshFailure,
} from "@/handlers/errors-revalidation/actions.js";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const panel = {
  padding: "12px",
  border: "1px solid #ccc",
  borderRadius: "6px",
  marginBottom: "12px",
} as const;

/**
 * The controls sit in the layout, outside every boundary the stock read can
 * fail into: the note keeps what you typed, and the Save result and the
 * revalidationError report stay on screen.
 */
export function RevalidationControls(): ReactNode {
  const { data: flag } = useLoader(StockFailureFlagLoader);
  const save = useAction(saveNote);
  const [note, setNote] = useState("");
  const [result, setResult] = useState("nothing saved yet");
  // useAction drops an action's state shortly after it settles: latch the
  // report so it stays readable.
  const [report, setReport] = useState("none");
  useEffect(() => {
    if (save.revalidationError != null) {
      setReport(message(save.revalidationError));
    }
  }, [save.revalidationError]);

  const onSave = async (): Promise<void> => {
    setReport("none");
    const saved = await saveNote(note);
    setResult(`Saved #${saved.saved}: ${saved.note || "(empty note)"}`);
  };

  return (
    <div style={panel} data-testid="rv-controls">
      <p>
        <button
          type="button"
          data-testid="rv-fail-toggle"
          data-failing={flag.failing ? "true" : "false"}
          onClick={() => {
            void setStockRefreshFailure(!flag.failing);
          }}
        >
          {flag.failing
            ? "Stock refresh fails: turn it off"
            : "Make the stock refresh fail"}
        </button>{" "}
        A server cookie. The stock loader&apos;s revalidate() skips this toggle,
        so the next Save is what reruns it.
      </p>
      <label style={{ display: "block", marginBottom: "8px" }}>
        Note (React state outside every boundary):{" "}
        <input
          data-testid="rv-note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
      <button type="button" data-testid="rv-save" onClick={onSave}>
        Save
      </button>{" "}
      <span data-testid="rv-save-state">{save.state}</span>
      <p>
        <strong>Action result</strong> (what <code>await saveNote()</code>{" "}
        resolved with): <span data-testid="rv-result">{result}</span>
      </p>
      <p>
        <strong>
          <code>useAction(saveNote).revalidationError</code>
        </strong>
        : <span data-testid="rv-revalidation-error">{report}</span>
      </p>
    </div>
  );
}

export function StockList(): ReactNode {
  const { data } = useLoader(StockLoader);
  return (
    <div data-testid="rv-stock">
      <p data-testid="rv-stock-as-of">stock as of save #{data.asOfSave}</p>
      <ul>
        {data.items.map((item) => (
          <li key={item.sku}>
            {item.name}: {item.qty}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The app's own error boundary around the stock read. It resets when
 * `resetKey` changes: the page passes the save counter, a loader that reruns
 * with the stock loader and is read outside this boundary, so a Save whose
 * stock rerun succeeds clears the error in the render that brings the new
 * stock. (A reset when the action settles could run before React rendered
 * the commit, and catch the old failure again.)
 */
export class StockBoundary extends Component<
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
      return (
        <div
          data-testid="rv-local-fallback"
          style={{ ...panel, background: "#fff4e5", borderColor: "#f0a020" }}
        >
          <strong>Stock unavailable</strong> (the page&apos;s own React
          ErrorBoundary around the read):{" "}
          <span data-testid="rv-local-fallback-message">
            {message(this.state.error)}
          </span>
        </div>
      );
    }
    return this.props.children;
  }
}

function SaveStatus(): ReactNode {
  const { data } = useLoader(SaveStatusLoader);
  return (
    <p data-testid="rv-saves">
      Saves the page&apos;s other loader saw: {data.saves}
    </p>
  );
}

/** The stock read inside the page's own error boundary. */
export function RevalidationLocalPage({ title }: { title: string }): ReactNode {
  const { data } = useLoader(SaveStatusLoader);
  return (
    <section data-testid="rv-page" style={panel}>
      <h3>{title}</h3>
      <StockBoundary resetKey={data.saves}>
        <StockList />
      </StockBoundary>
      <SaveStatus />
    </section>
  );
}

/** The stock read with no boundary of the page's own: errorBoundary() catches. */
export function RevalidationRouteBoundaryPage(): ReactNode {
  return (
    <section data-testid="rv-page" style={panel}>
      <h3>The route&apos;s errorBoundary() catches</h3>
      <StockList />
      <SaveStatus />
    </section>
  );
}

/** The clientUrls() group's page. */
export function RevalidationGroupPage(): ReactNode {
  return (
    <RevalidationLocalPage title="clientUrls() group: a local React ErrorBoundary around the read" />
  );
}

export function StockSkeleton(): ReactNode {
  return <p data-testid="rv-skeleton">Loading stock…</p>;
}
