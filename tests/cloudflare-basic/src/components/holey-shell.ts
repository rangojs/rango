import { createHandle, createLocationState } from "@rangojs/router";

// dc-t93 fixtures shared by the holey-throws server routes and their client
// readers. Not a "use client" module: the server needs the definitions
// themselves, not client references.

/** The state a loader redirect() carries to /holey-throws/shell-target. */
export const HoleyShellState = createLocationState<{ text: string }>();

/** Pushed by the /holey-throws/shell-hooks handler. */
export const HoleyShellNotes = createHandle<string, string[]>((segments) =>
  segments.flat(),
);
