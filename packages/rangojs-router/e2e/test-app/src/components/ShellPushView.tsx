"use client";

import { useHandle, useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";
import {
  ShellPushNotes,
  type ShellPushData,
} from "../urls/shell-push-ownership.defs.js";

// The push-ownership fixture's view: the loader's value and one row per
// ShellPushNotes push, so a value and the push that describes it can be
// compared, and a duplicated push renders twice.
export function ShellPushView({
  loader,
}: {
  loader: LoaderDefinition<ShellPushData>;
}) {
  const {
    data: { value },
  } = useLoader(loader);
  const notes = (useHandle(ShellPushNotes) ?? []).flat();
  return (
    <section>
      <p data-testid="push-value">{value}</p>
      <ul>
        {notes.map((note, index) => (
          <li key={index} data-testid="push-note">
            {note}
          </li>
        ))}
      </ul>
    </section>
  );
}
