import { createHandle } from "@rangojs/router";

// Crumbs pushed by the /loader-cache-dep dependency loader. No key-based
// dedupe, so a doubled push renders twice.
export const DepCrumbs = createHandle<string, string[]>((segments) =>
  segments.flat(),
);
