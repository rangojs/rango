import { createHandle } from "@rangojs/router";

// Notes pushed by /sc/handle: one with the handler's output, one later. In
// its own module so the client reader does not pull the server urls file.
export const ScNotes = createHandle<string, string[]>((segments) =>
  segments.flat(),
);
