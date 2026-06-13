import { urls } from "@rangojs/router";

// Suffix-param longest-wins (#568).
//
// Overlapping suffixes must resolve by specificity (longest literal suffix),
// not by route declaration order. The shorter `.data` route is declared FIRST
// so this fixture exercises the bug path: before the build-time sort
// (route-trie.ts sortSuffixParams), `/suffix-overlap/app.v2.data` would match
// `:file.data` (file="app.v2"); after, it matches the more specific
// `:file.v2.data` (file="app"). A neutral `.data` suffix is used (not `.js` /
// `.html`) so the vanilla-Vite dev server does not intercept the request as a
// static asset before it reaches the RSC handler.
export const suffixOverlapPatterns = urls(({ path }) => [
  path(
    "/:file.data",
    (ctx) => (
      <div data-testid="suffix-data">
        <span data-testid="suffix-data-file">{ctx.params.file}</span>
      </div>
    ),
    { name: "data" },
  ),
  path(
    "/:file.v2.data",
    (ctx) => (
      <div data-testid="suffix-v2data">
        <span data-testid="suffix-v2data-file">{ctx.params.file}</span>
      </div>
    ),
    { name: "v2data" },
  ),
]);
