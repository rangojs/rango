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

  it("throws for an item created above the orphan cache() marker that lists it", () => {
    const parent = parentEntry();
    expect(() =>
      withDslStore(parent, () =>
        layout(Shell, () => {
          const a = route("a", Page);
          return [cache({ ttl: 60 }), a];
        }),
      ),
    ).toThrow(/route\(\) declared outside the cache\(\) it is nested in \[/);
  });

  it("throws for an item created inside a cache() marker listed after it", () => {
    const parent = parentEntry();
    expect(() =>
      withDslStore(parent, () =>
        layout(Shell, () => {
          const marker = cache({ ttl: 60 });
          const a = route("a", Page);
          return [a, marker];
        }),
      ),
    ).toThrow(
      /route\(\) is created inside the cache\(\) marker listed after it \[/,
    );
  });

  it("keeps a cache() marker called without returning it", () => {
    const parent = parentEntry();
    const item = withDslStore(parent, () =>
      layout(Shell, () => {
        cache({ ttl: 60 });
        return [route("a", Page)];
      }),
    );
    expect(item.uses?.map((use) => use?.type)).toEqual(["route"]);
  });

  it("checks the top-level urls() list against its own entry", () => {
    const parent = parentEntry();
    expect(() =>
      withDslStore(parent, () =>
        urls(({ cache, path }) => {
          const a = path("/a", Page, { name: "a" });
          return [cache({ ttl: 60 }), a];
        }).handler(),
      ),
    ).toThrow(/route\(\) declared outside the cache\(\) it is nested in \[/);
  });

  it("keeps a top-level list whose items are created where they are listed", () => {
    const parent = parentEntry();
    expect(() =>
      withDslStore(parent, () =>
        urls(({ cache, path }) => [
          cache({ ttl: 60 }),
          path("/a", Page, { name: "a" }),
        ]).handler(),
      ),
    ).not.toThrow();
  });

  it("throws for a definition created in a nested callback and returned above", () => {
    const parent = parentEntry();
    expect(() =>
      withDslStore(parent, () =>
        urls(({ path, layout }) => {
          let inner!: AllUseItems;
          return [
            layout(Shell, () => {
              inner = path("/a", Page, { name: "a" });
              return [];
            }),
            inner,
          ];
        }).handler(),
      ),
    ).toThrow(NESTED_IN_LAYOUT);
  });

  it("keeps a factory called inside the callback whose list holds its items", () => {
    const parent = parentEntry();
    const factory = () => [layout(Shell, () => [route("a", Page)])];
    const item = withDslStore(parent, () => layout(Shell, () => factory()));
    expect(item.uses?.map((use) => use?.type)).toEqual(["layout"]);
  });

  it("throws for a factory called in another callback", () => {
    const parent = parentEntry();
    const factory = () => [route("a", Page)];
    expect(() =>
      withDslStore(parent, () => {
        const items = factory();
        return layout(Shell, () => items);
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
