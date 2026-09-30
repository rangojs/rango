"use client";

import { useHandle, useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";
import {
  ShellLiveDepNotes,
  type ShellLiveDepData,
} from "../urls/shell-cache.defs.js";

// The live-dep fixture's hole: the live loader's value and one row per
// ShellLiveDepNotes push (test id shell-<note kind>), so a duplicated push
// renders twice.
export function ShellLiveDepView({
  loader,
}: {
  loader: LoaderDefinition<ShellLiveDepData>;
}) {
  const {
    data: { liveDep, inner },
  } = useLoader(loader);
  const notes = (useHandle(ShellLiveDepNotes) ?? []).flat();
  return (
    <section>
      <p data-testid="shell-live-dep">{liveDep}</p>
      <p data-testid="shell-inner-dep">{inner}</p>
      <ul>
        {notes.map((note, index) => (
          <li
            key={index}
            data-testid={`shell-${note.slice(0, note.indexOf("@"))}`}
          >
            {note}
          </li>
        ))}
      </ul>
    </section>
  );
}
