/**
 * Structural entries capture the include scope their DSL position is in
 * (EntryData.reverseScope), which segment resolution hands their handler's
 * ctx and their loaders' ctx: a layout's `ctx.reverse(".name")` resolves in
 * the module that defined the layout, not the matched route's module. A route's
 * loaders carry none (they resolve from the route's name).
 */
import { describe, it, expect } from "vitest";
import { runWithPrefixes, type EntryData } from "../../server/context.js";
import { layout, loader, parallel } from "../dsl-helpers.js";
import type { LoaderDefinition } from "../../types.js";
import { parentEntry, withDslStore } from "./dsl-test-helpers.js";

const Loader = {
  __brand: "loader",
  $$id: "test#ScopeLoader",
  fn: async () => "data",
} as unknown as LoaderDefinition<any>;

function addedLayout(parent: EntryData): EntryData {
  return parent.layout[parent.layout.length - 1]!;
}

describe("reverseScope stamping", () => {
  it("a layout, its parallel and its loader capture the include they are in", () => {
    const parent = parentEntry();
    withDslStore(parent, () =>
      runWithPrefixes("/:accountId", "account", () =>
        runWithPrefixes("/:projectId", "project", () =>
          layout(null as never, () => [
            loader(Loader),
            parallel({ "@aside": null as never }),
          ]),
        ),
      ),
    );
    const entry = addedLayout(parent);
    const scope = { prefix: "account.project", rootScoped: false };
    expect(entry.reverseScope).toEqual(scope);
    expect(entry.loader[0]!.reverseScope).toEqual(scope);
    expect(entry.parallel["@aside"]!.reverseScope).toEqual(scope);
  });

  it("a layout outside any named include is root-scoped", () => {
    const parent = parentEntry();
    withDslStore(parent, () => layout(null as never, () => []));
    expect(addedLayout(parent).reverseScope).toEqual({
      prefix: undefined,
      rootScoped: true,
    });
  });

  it("a route's loader carries no scope", () => {
    const route = { ...parentEntry(), type: "route" } as EntryData;
    withDslStore(route, () =>
      runWithPrefixes("/:accountId", "account", () => loader(Loader)),
    );
    expect(route.loader[0]!.reverseScope).toBeUndefined();
  });
});
