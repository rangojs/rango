import { createHandle } from "@rangojs/router";

// Notes pushed by the /prefetch-false fixture (urls/prefetch-false.tsx) and
// listed by PrefetchFalseNotes in its hub layout. In its own module so the
// client consumer does not pull the server urls file.
export const PfNotes = createHandle<string, string[]>((segments) =>
  segments.flat(),
);
