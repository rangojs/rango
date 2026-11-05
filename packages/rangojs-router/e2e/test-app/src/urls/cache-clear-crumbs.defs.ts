import { createHandle } from "@rangojs/router";

// e2e/cache.test.ts "cache-clear-crumbs": the layout's crumb. Its handler
// pushes it only on a render the request's `?cc=1` asks for, so a later render
// of the same handler pushes nothing and the page must clear it.
export const CacheClearCrumbs = createHandle<string, string[]>((segments) =>
  segments.flat(),
);
