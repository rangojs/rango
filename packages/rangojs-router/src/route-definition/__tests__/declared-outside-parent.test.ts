/**
 * A DSL definition registers under the entry whose callback creates it: the
 * helper fixes its entry's parent pointer, short code and namespace when it
 * runs. A definition created at one level and returned from a callback at
 * another used to keep the first level silently — `const a = path("/a", A)`
 * declared at the top of urls() and nested in `layout(L, () => [a])` registered
 * under the root, so L never rendered and the route answered 200 from the root.
 * The shape is now rejected where it is written.
 *
 * The controls pin the shapes that must keep working: the same definition
 * created inside the callback, and the documented orphan `cache()` form, where
 * ctx.parent moves down to the cache entry so the siblings after it are
 * declared one level below the callback's own entry.
 */
import { describe, expect, it } from "vitest";
import { parentEntry, withDslStore } from "./dsl-test-helpers.js";
import { cache, layout, loader, route } from "../dsl-helpers.js";
import { createIncludeHelper } from "../../urls/include-helper.js";
import { urls } from "../../urls.js";
import type { LoaderDefinition } from "../../types.js";

function Shell() {
  return null;
}
function Page() {
  return null;
}

function testLoaderDef(): LoaderDefinition<any> {
  return {
    __brand: "loader",
    $$id: "test#Loader",
    fn: async () => "data",
  } as unknown as LoaderDefinition<any>;
}

const NESTED_IN_LAYOUT = /declared outside the layout\(\) it is nested in/;

describe("a definition nested under an entry it was not created in", () => {
  it("throws for a route created above the layout that nests it", () => {
    const parent = parentEntry();
    expect(() =>
      withDslStore(parent, () => {
        const a = route("a", Page);
        layout(Shell, () => [a]);
      }),
    ).toThrow(NESTED_IN_LAYOUT);
  });

  it("throws for a route created above a cache() block that nests it", () => {
    const parent = parentEntry();
    expect(() =>
      withDslStore(parent, () => {
        const a = route("a", Page);
        cache({ ttl: 60 }, () => [a]);
      }),
    ).toThrow(/declared outside the cache\(\) it is nested in/);
  });

  it("throws for a loader created above the layout that nests it", () => {
    const parent = parentEntry();
    expect(() =>
      withDslStore(parent, () => {
        const data = loader(testLoaderDef());
        layout(Shell, () => [data]);
      }),
    ).toThrow(NESTED_IN_LAYOUT);
  });

  it("throws for an include() created above the layout that nests it", () => {
    const parent = parentEntry();
    const include = createIncludeHelper<any>();
    const patterns = urls(({ path }) => [path("/a", Page, { name: "a" })]);
    expect(() =>
      withDslStore(parent, () => {
        const block = include("/block", patterns);
        layout(Shell, () => [block]);
      }),
    ).toThrow(NESTED_IN_LAYOUT);
  });

  it("keeps a route created inside the layout's own callback", () => {
    const parent = parentEntry();
    const item = withDslStore(parent, () =>
      layout(Shell, () => [route("a", Page)]),
    );
    expect(item.uses?.[0]?.type).toBe("route");
  });

  it("keeps the orphan cache() form: siblings after it attach under it", () => {
    const parent = parentEntry();
    const item = withDslStore(parent, () =>
      layout(Shell, () => [
        cache({ ttl: 60 }),
        route("a", Page),
        route("b", Page),
      ]),
    );
    expect(item.uses?.map((use) => use?.type)).toEqual([
      "cache",
      "route",
      "route",
    ]);
  });
});
