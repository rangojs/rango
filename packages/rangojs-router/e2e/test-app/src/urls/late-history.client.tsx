"use client";

import { useEffect } from "react";
import { useHandle, useLoader } from "@rangojs/router/client";
import {
  LateHistoryNotes,
  LateHistorySlowLoader,
} from "./late-history.defs.js";

// In the layout, outside the loading() boundary: hydrates with the root. The
// router's data-hydrated attribute waits for every boundary, so the effect
// marks the root's own hydration.
export function LateHistoryNotesReader() {
  useEffect(() => {
    document.documentElement.setAttribute("data-lh-mounted", "");
  }, []);
  const notes = (useHandle(LateHistoryNotes) ?? []).flat();
  return (
    <ul data-testid="lh-notes">
      {notes.map((note, index) => (
        <li key={index} data-testid="lh-note">
          {note}
        </li>
      ))}
    </ul>
  );
}

export function LateHistorySlowValue() {
  const { data } = useLoader(LateHistorySlowLoader);
  return <p data-testid="lh-slow-value">{data.value}</p>;
}
