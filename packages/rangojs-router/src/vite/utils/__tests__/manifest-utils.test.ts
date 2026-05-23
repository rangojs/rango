import { describe, it, expect } from "vitest";
import { generateManifestFull } from "../../../build/generate-manifest";
import { flattenLeafEntries } from "../manifest-utils";
import { urls } from "../../../urls";

type Precomputed = Array<{
  staticPrefix: string;
  routes: Record<string, string>;
}>;

function flatten(patterns: ReturnType<typeof urls>): Precomputed {
  const manifest = generateManifestFull(patterns, 0);
  const result: Precomputed = [];
  flattenLeafEntries(manifest.prefixTree, manifest.routeManifest, result);
  return result;
}

describe("flattenLeafEntries — nested lazy-include staticPrefix collision (#506)", () => {
  it("does NOT precompute a nested-include leaf whose staticPrefix collapses onto an ancestor (dynamic param)", () => {
    // root -> include("/g", group) -> group has a dynamic sibling path and
    // include("/:id/sub", section) -> section's OWN top-level is itself a lazy
    // include("/", item) -> item path "/leaf".
    // The dynamic ":id" collapses every nested entry's staticPrefix to "/g", so
    // group.section.item.leaf and its "group" ancestor share staticPrefix "/g".
    // Precomputing that leaf under "/g" would let the "group" lazy entry claim a
    // route it cannot register (behind two further nested lazy includes) ->
    // RouteNotFoundError / 404 (#506). Such leaves must resolve via the handler
    // chain instead.
    const item = urls(({ path }) => [
      path("/leaf", () => null, { name: "leaf" }),
    ]);
    const section = urls(({ include }) => [
      include("/", item, { name: "item" }),
    ]);
    const group = urls(({ path, layout, include }) => [
      layout(
        () => null,
        () => [
          path("/:id", () => null, { name: "index" }),
          include("/:id/sub", section, { name: "section" }),
        ],
      ),
    ]);
    const root = urls(({ path, layout, include }) => [
      layout(
        () => null,
        () => [
          path("/", () => null, { name: "home" }),
          include("/g", group, { name: "group" }),
        ],
      ),
    ]);

    const result = flatten(root);
    const collided = result.find(
      (e) => e.staticPrefix === "/g" && "group.section.item.leaf" in e.routes,
    );
    expect(collided).toBeUndefined();
  });

  it("still precomputes a nested leaf when each include level has a distinct staticPrefix (static)", () => {
    const item = urls(({ path }) => [
      path("/leaf", () => null, { name: "leaf" }),
    ]);
    const section = urls(({ include }) => [
      include("/", item, { name: "item" }),
    ]);
    const group = urls(({ layout, include }) => [
      layout(
        () => null,
        () => [include("/sub", section, { name: "section" })],
      ),
    ]);
    const root = urls(({ layout, include }) => [
      layout(
        () => null,
        () => [include("/g", group, { name: "group" })],
      ),
    ]);

    const result = flatten(root);
    const leaf = result.find((e) => "group.section.item.leaf" in e.routes);
    expect(leaf).toBeDefined();
    expect(leaf!.staticPrefix).toBe("/g/sub/");
  });

  it("precomputes a simple single-level include leaf", () => {
    const api = urls(({ path }) => [
      path("/users", () => null, { name: "users" }),
    ]);
    const root = urls(({ path, include }) => [
      path("/", () => null, { name: "home" }),
      include("/api", api, { name: "api" }),
    ]);

    const result = flatten(root);
    const leaf = result.find((e) => "api.users" in e.routes);
    expect(leaf).toBeDefined();
    expect(leaf!.staticPrefix).toBe("/api");
  });
});
