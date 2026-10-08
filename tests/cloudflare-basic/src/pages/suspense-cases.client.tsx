"use client";

import { useActionState, useEffect, useState } from "react";
import {
  useHandle,
  useLoader,
  useNavigation,
  useRouter,
} from "@rangojs/router/client";
import {
  ScALoader,
  ScBLoader,
  ScItemLoader,
  ScLiveLoader,
  ScOwnALoader,
  ScOwnBLoader,
  ScShellLoader,
  ScSlowLoader,
} from "./suspense-cases.loaders.js";
import { scBumpAction } from "./suspense-cases.actions.js";
import { ScNotes } from "./suspense-cases.handle.js";

/**
 * One value per mounted instance, set after mount so the document's HTML
 * matches. A remount shows another value; a reconcile keeps it.
 */
export function ScInstance({ id }: { id: string }) {
  const [instance, setInstance] = useState("");
  useEffect(() => {
    setInstance((prev) => prev || Math.random().toString(36).slice(2));
  }, []);
  return <span data-testid={`sc-instance-${id}`}>{instance}</span>;
}

export function ScShellValue() {
  const { data } = useLoader(ScShellLoader);
  return <span data-testid="sc-shell-value">{data.value}</span>;
}

export function ScItemValue({ testId }: { testId: string }) {
  const { data } = useLoader(ScItemLoader);
  return <span data-testid={testId}>{data.value}</span>;
}

export function ScAValue() {
  const { data } = useLoader(ScALoader);
  return <span data-testid="sc-a-value">{data.value}</span>;
}

export function ScBValue() {
  const { data } = useLoader(ScBLoader);
  return <span data-testid="sc-b-value">{data.value}</span>;
}

export function ScSlowValue() {
  const { data } = useLoader(ScSlowLoader);
  return <span data-testid="sc-slow-value">{data.value}</span>;
}

export function ScOwnAValue() {
  const { data } = useLoader(ScOwnALoader);
  return <span data-testid="sc-own-a-value">{data.value}</span>;
}

export function ScOwnBValue() {
  const { data } = useLoader(ScOwnBLoader);
  return <span data-testid="sc-own-b-value">{data.value}</span>;
}

/** Reads a loader and refetches it in place: no navigation, no action. */
export function ScLive() {
  const { data, load } = useLoader(ScLiveLoader);
  return (
    <>
      <span data-testid="sc-live-value">{data.value}</span>
      <button type="button" data-testid="sc-reload" onClick={() => void load()}>
        reload
      </button>
    </>
  );
}

/** Reads the notes handle: its late push arrives after the page committed. */
export function ScNotesView() {
  const notes = useHandle(ScNotes) ?? [];
  return <span data-testid="sc-notes">{notes.join(",")}</span>;
}

/** Re-renders with every navigation state change, while the page streams. */
export function ScNavState() {
  const state = useNavigation((nav) => nav.state);
  return <span data-testid="sc-nav">{state}</span>;
}

export function ScControls() {
  const router = useRouter();
  const [count, run, pending] = useActionState(scBumpAction, 0);
  return (
    <>
      <form action={run}>
        <button type="submit" data-testid="sc-action">
          {`actions:${count}${pending ? " (pending)" : ""}`}
        </button>
      </form>
      <button
        type="button"
        data-testid="sc-refresh"
        onClick={() => void router.refresh()}
      >
        refresh
      </button>
    </>
  );
}
