/**
 * A DSL definition registers under the entry whose callback creates it: the
 * helper fixes its entry's parent pointer, short code and namespace when it
 * runs. A definition created at one level and returned from a callback at
 * another used to keep the first level silently — `const a = path("/a", A)`
 * declared at the top of urls() and nested in `layout(L, () => [a])` registered
 * under the root, so L never rendered and the route answered 200 from the root.
 * The shape is now rejected where it is written.
 *
 * The per-helper table is the "every helper marks its item" guard: a helper
 * added without recording the entry it declared its item under would escape
 * the check, and its row here fails until it records one.
 *
 * The controls pin the shapes that must keep working: the same definition
 * created inside the callback, and the documented orphan `cache()` form, where
 * ctx.parent moves down to the cache entry so the siblings after it are
 * declared one level below the callback's own entry.
 */
import { describe, expect, it } from "vitest";
import { parentEntry, withDslStore } from "./dsl-test-helpers.js";
import {
  cache,
  errorBoundary,
  intercept,
  layout,
  loading,
  loader,
  middleware,
  notFoundBoundary,
  parallel,
  revalidate,
  route,
  transition,
} from "../dsl-helpers.js";
import { createIncludeHelper } from "../../urls/include-helper.js";
import { createPathHelper } from "../../urls/path-helper.js";
import { urls } from "../../urls.js";
import type { AllUseItems } from "../../route-types.js";
import type { LoaderDefinition } from "../../types.js";

function Shell() {
  return null;
}
function Page() {
  return null;
}
const mw = () => undefined;

function testLoaderDef(): LoaderDefinition<any> {
  return {
    __brand: "loader",
    $$id: "test#Loader",
    fn: async () => "data",
  } as unknown as LoaderDefinition<any>;
}

const NESTED_IN_LAYOUT = /declared outside the layout\(\) it is nested in/;

/** One item per helper, each declared under the callback's own entry. */
const DECLARATIONS: Array<[string, () => AllUseItems]> = [
  ["route()", () => route("a", Page)],
  ["path()", () => createPathHelper<any>()("/b", Page, { name: "b" })],
  ["layout()", () => layout(Shell)],
  ["cache()", () => cache({ ttl: 60 }, () => [])],
  ["middleware()", () => middleware(() => undefined)],
  ["transition()", () => transition({})],
  ["parallel()", () => parallel({ "@side": Page })],
  ["intercept()", () => intercept("@modal", "a", Page)],
  ["loader()", () => loader(testLoaderDef())],
  ["loading()", () => loading(null as never)],
  ["revalidate()", () => revalidate(() => true)],
  ["errorBoundary()", () => errorBoundary(null as never)],
  ["notFoundBoundary()", () => notFoundBoundary(null as never)],
  [
    "include()",
    () =>
      createIncludeHelper<any>()(
        "/block",
        urls(({ path }) => [path("/a", Page)]),
      ),
  ],
];

describe("a definition nested under an entry it was not created in", () => {
  for (const [helper, declare] of DECLARATIONS) {
    it(`throws for a ${helper} item created above the layout that nests it`, () => {
      const parent = parentEntry();
      expect(() =>
        withDslStore(parent, () => {
          const item = declare();
          layout(Shell, () => [item]);
        }),
      ).toThrow(NESTED_IN_LAYOUT);
    });
  }

  it("names the callback the item belongs in", () => {
    const parent = parentEntry();
    expect(() =>
      withDslStore(parent, () => {
        const a = route("a", Page);
        cache({ ttl: 60 }, () => [a]);
      }),
    ).toThrow(/route\(\) declared outside the cache\(\) it is nested in \[/);
  });

  // The callback is named by the helper that ran it, not by its entry type:
  // middleware(fn, children) and transition(config, children) build transparent
  // layout entries, and intercept() validates against a spread of the enclosing
  // entry, so all three used to report "layout()".
  // `item` is any: each helper's use() slot takes its own item union, and the
  // point here is the message, not the shape the type system already rejects.
  const CONTAINERS: Array<[string, (item: any) => void]> = [
    ["layout", (item) => void layout(Shell, () => [item])],
    ["cache", (item) => void cache({ ttl: 60 }, () => [item])],
    ["middleware", (item) => void middleware(mw, () => [item])],
    ["transition", (item) => void transition({}, () => [item])],
    ["intercept", (item) => void intercept("@modal", "a", Page, () => [item])],
    ["parallel", (item) => void parallel({ "@side": Page }, () => [item])],
    ["loader", (item) => void loader(testLoaderDef(), () => [item])],
    ["route", (item) => void route("b", Page, () => [item])],
    [
      "path",
      (item) =>
        void createPathHelper<any>()("/b", Page, { name: "b" }, () => [item]),
    ],
  ];

  for (const [helper, nest] of CONTAINERS) {
    it(`names ${helper}() as the callback an outside item belongs in`, () => {
      const parent = parentEntry();
      expect(() =>
        withDslStore(parent, () => {
          const item = route("a", Page);
          nest(item);
        }),
      ).toThrow(
        new RegExp(
          `^Invariant: route\\(\\) declared outside the ${helper}\\(\\) it is nested in \\[`,
        ),
      );
    });
  }

  // path() and route() both return a `type: "route"` item, so the item is named
  // by the helper the user called, not by its type.
  it("names the helper that created the item, not the item's type", () => {
    const parent = parentEntry();
    expect(() =>
      withDslStore(parent, () => {
        const a = createPathHelper<any>()("/a", Page, { name: "a" });
        layout(Shell, () => [a]);
      }),
    ).toThrow(/^Invariant: path\(\) declared outside the layout\(\)/);
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
