"use client";

import { useLayoutEffect, useRef, type RefObject } from "react";
import {
  useHandle,
  useLoader,
  useLocationState,
  usePathname,
} from "@rangojs/router/client";
import { HydrationNotes } from "../../handles/hydration-notes.js";
import {
  HydrationDemoLocationState,
  LateNoteLoader,
} from "../../loaders/hydration-demo.js";

/**
 * Counts the calling component's renders and shows the count after each
 * commit. It is written to the DOM from a layout effect, not rendered, so the
 * server HTML and the hydrating render agree. Development's StrictMode renders
 * every component twice, so counts there are doubled.
 */
function useRenderCount(): RefObject<HTMLSpanElement | null> {
  const renders = useRef(0);
  renders.current += 1;
  const node = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    if (node.current) node.current.textContent = String(renders.current);
  });
  return node;
}

/**
 * In the layout, so it hydrates with the root. Its selection is the number of
 * notes: it re-renders when the late note is released to it, and not before.
 */
export function NoteCountReader() {
  const count = useHandle(HydrationNotes, (notes) => notes.flat().length);
  const renders = useRenderCount();
  return (
    <p>
      Notes: <strong data-testid="hyd-note-count">{count}</strong> (renders:{" "}
      <span ref={renders} data-testid="hyd-note-count-renders" />)
    </p>
  );
}

/**
 * In the layout. Its selection never changes, so it never re-renders after
 * hydration, also when the late note arrives.
 */
export function ConstantReader() {
  const value = useHandle(HydrationNotes, () => "unchanged");
  const renders = useRenderCount();
  return (
    <p>
      Constant selection: <strong>{value}</strong> (renders:{" "}
      <span ref={renders} data-testid="hyd-constant-renders" />)
    </p>
  );
}

/**
 * Inside the route's loading() boundary, which hydrates after the root. It
 * hydrates with the notes the server rendered, then shows the late note.
 */
export function LateHandleContent() {
  const { data } = useLoader(LateNoteLoader);
  const notes = useHandle(HydrationNotes, (all) => all.flat());
  const renders = useRenderCount();
  return (
    <section data-testid="hyd-late-content">
      <p data-testid="hyd-loader-data">{data.message}</p>
      <ul>
        {notes.map((note) => (
          <li key={note} data-testid="hyd-note">
            {note}
          </li>
        ))}
      </ul>
      <p>
        Renders: <span ref={renders} data-testid="hyd-late-renders" />
      </p>
    </section>
  );
}

export function LateStateWriter() {
  return (
    <button
      type="button"
      data-testid="hyd-state-write"
      onClick={() =>
        HydrationDemoLocationState.write({ label: "stored value" })
      }
    >
      Write location state
    </button>
  );
}

function StateValue({ label, testId }: { label: string; testId: string }) {
  const state = useLocationState(HydrationDemoLocationState);
  const renders = useRenderCount();
  return (
    <p>
      {label}:{" "}
      <strong data-testid={`${testId}-value`}>{state?.label ?? "empty"}</strong>{" "}
      (renders: <span ref={renders} data-testid={`${testId}-renders`} />)
    </p>
  );
}

/**
 * On the page, outside the late boundary. A Link's state reaches it in the
 * commit that shows the page, while the late boundary still loads.
 */
export function PageStateReader() {
  return <StateValue label="Location state, page" testId="hyd-page-state" />;
}

/**
 * Inside a Suspense boundary whose server content arrives late. After a
 * navigation it shows the entry's state when the boundary resolves. On a
 * document load it hydrates as the server rendered it ("empty": the server
 * has no history state), then shows the entry's stored state.
 */
export function LateStateReader() {
  return (
    <StateValue label="Location state, late boundary" testId="hyd-state" />
  );
}

declare global {
  interface Window {
    __hydOtherRenders?: { pathname: string; notes: string }[];
  }
}

/**
 * On the other page. Records what every render read, so a test can check
 * that a navigation committed while the previous page was still streaming
 * never rendered that page's pathname or handles here.
 */
export function OtherPageReaders() {
  const pathname = usePathname();
  const notes = useHandle(HydrationNotes, (all) => all.flat().join(", "));
  if (typeof window !== "undefined") {
    (window.__hydOtherRenders ??= []).push({ pathname, notes });
  }
  return (
    <p>
      Pathname: <strong data-testid="hyd-other-pathname">{pathname}</strong>;
      notes: <strong data-testid="hyd-other-notes">{notes}</strong>
    </p>
  );
}
