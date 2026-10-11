"use client";

import { useHandle } from "@rangojs/router/client";
import { PfNotes } from "../urls/prefetch-false.handle.js";

/** One `pf-note-<note>` per handle push of the page on screen. */
export function PrefetchFalseNotes() {
  const notes = useHandle(PfNotes);
  return (
    <p data-testid="pf-notes">
      {notes.map((note) => (
        <span key={note} data-testid={`pf-note-${note}`}>
          {note}
        </span>
      ))}
    </p>
  );
}
