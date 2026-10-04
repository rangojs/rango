"use client";

import { useHandle, useLoader } from "@rangojs/router/client";
import type { LoaderDefinition } from "@rangojs/router";
import {
  PprPushNotes,
  type PprPushData,
} from "../loaders/ppr-push-ownership.js";

// The push-ownership fixture's view: the loader's value and one row per
// PprPushNotes push, so a value and the push that describes it can be
// compared, and a duplicated push renders twice.
export function PprPushView({
  loader,
}: {
  loader: LoaderDefinition<PprPushData>;
}) {
  const {
    data: { value },
  } = useLoader(loader);
  const notes = (useHandle(PprPushNotes) ?? []).flat();
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
