import { createHandle } from "@rangojs/router";

// Crumbs pushed by the /cache-test/cached-loader-dep dependency loader. No
// key-based dedupe, so a doubled push renders twice. Kept in its own module
// so the client consumer (DepCrumbsView) does not pull the server urls file.
export const DepCrumbs = createHandle<string, string[]>((segments) =>
  segments.flat(),
);
