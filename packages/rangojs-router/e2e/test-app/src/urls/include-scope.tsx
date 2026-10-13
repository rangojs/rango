import { urls } from "@rangojs/router";

// Hidden include-scope names (#1104). Route keys behind unnamed includes are
// internal ($prefix_*); build discovery and the runtime must give each include
// the same one, or the trie's key has no runtime owner.

// An unnamed include inside an unnamed include, the shape #1104 reported.
const signInPatterns = urls(({ path }) => [
  path(
    "/nested-unnamed/login",
    () => <h1 data-testid="include-scope-login">Nested unnamed login</h1>,
    { name: "login" },
  ),
]);

export const includeScopePublicPatterns = urls(({ include }) => [
  include("/", signInPatterns),
]);

// X and Z both name a route "page"; Z sits behind a transparent include. A
// counter-derived hidden name gave both the same key.
const xPatterns = urls(({ path }) => [
  path("/x", () => <h1 data-testid="include-scope-x">Include scope X</h1>, {
    name: "page",
  }),
]);

const zPatterns = urls(({ path }) => [
  path("/z", () => <h1 data-testid="include-scope-z">Include scope Z</h1>, {
    name: "page",
  }),
]);

const transparentPatterns = urls(({ include }) => [include("/", zPatterns)]);

export const includeScopeCollisionPatterns = urls(({ include }) => [
  include("/", xPatterns),
  include("/", transparentPatterns, { name: "" }),
]);
