import { urls } from "@rangojs/router";

// Hidden include-scope names (#1104). Route keys behind unnamed includes are
// internal ($prefix_*); build discovery and the runtime must give each include
// the same one, or the trie's key has no runtime owner. Each page has a JSON
// twin so test/include-scope-dispatch.test.ts can dispatch the same tree.

// An unnamed include inside an unnamed include, the shape #1104 reported.
const signInPatterns = urls(({ path }) => [
  path(
    "/nested-unnamed/login",
    () => <h1 data-testid="include-scope-login">Nested unnamed login</h1>,
    { name: "login" },
  ),
  path.json("/nested-unnamed/login.json", () => ({ page: "login" }), {
    name: "loginJson",
  }),
]);

export const includeScopePublicPatterns = urls(({ include }) => [
  include("/", signInPatterns),
]);

// X and Z name their routes alike; Z sits behind a transparent include. A
// counter-derived hidden name gave both the same keys.
const xPatterns = urls(({ path }) => [
  path("/x", () => <h1 data-testid="include-scope-x">Include scope X</h1>, {
    name: "page",
  }),
  path.json("/x.json", () => ({ page: "x" }), { name: "json" }),
]);

const zPatterns = urls(({ path }) => [
  path("/z", () => <h1 data-testid="include-scope-z">Include scope Z</h1>, {
    name: "page",
  }),
  path.json("/z.json", () => ({ page: "z" }), { name: "json" }),
]);

const transparentPatterns = urls(({ include }) => [include("/", zPatterns)]);

export const includeScopeCollisionPatterns = urls(({ include }) => [
  include("/", xPatterns),
  include("/", transparentPatterns, { name: "" }),
]);
