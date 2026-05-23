import { urls } from "@rangojs/router";
import { NestedLayout } from "./components/NestedLayout.js";

// Generic regression fixture for #506: a nested lazy-include chain under a
// dynamic-param prefix.
//
//   include("/g", group)                          -> name "group"
//     layout + path("/:id", index)                -> "group.index"
//            + include("/:id/sub", section)        -> "group.section"
//   section's OWN top-level is itself a lazy include:
//     include("/", item)                           -> "group.section.item"
//       item: path("/leaf", leaf)                  -> "group.section.item.leaf"
//
// The dynamic ":id" collapses every nested entry's staticPrefix to "/g", so the
// deeply-nested leaf and its "group" ancestor share staticPrefix "/g". The
// precompute must NOT let the "group" entry claim group.section.item.leaf (it
// cannot register a route behind two further nested lazy includes); the route
// must resolve via the handler chain. Names are intentionally neutral.

const itemPatterns = urls(({ path }) => [
  path(
    "/leaf",
    () => (
      <main data-testid="ni-leaf">
        <h1 data-testid="ni-leaf-title">Nested Leaf</h1>
      </main>
    ),
    { name: "leaf" },
  ),
]);

// The included object's OWN top-level is a lazy include (contributes "item").
const sectionPatterns = urls(({ include }) => [
  include("/", itemPatterns, { name: "item" }),
]);

export const groupPatterns = urls(({ path, layout, include }) => [
  layout(<NestedLayout />, () => [
    // Dynamic sibling sharing the leading param with the include below.
    path("/:id", () => <main data-testid="ni-index">Index</main>, {
      name: "index",
    }),
    include("/:id/sub", sectionPatterns, { name: "section" }),
  ]),
]);
