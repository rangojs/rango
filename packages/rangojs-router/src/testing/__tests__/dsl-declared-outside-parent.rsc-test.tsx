/**
 * A route declared outside the layout()/cache() that nests it used to render at
 * the root with no error: `const a = path("/a", A); return [layout(L, () =>
 * [a])]` matched ["M0L0","M0L0R0"] where the inline form matches
 * ["M0L0","M0L0L0","M0L0L0R0"], so L silently disappeared from the tree and the
 * response stayed 200. The DSL now rejects the shape where it is written,
 * naming the definition and the callback it must be created in.
 *
 * The two controls are the shapes that must keep working: the inline form (the
 * layout's segment stays in `matched`) and the documented orphan `cache()`
 * form, where the siblings after `cache()` attach under its entry one level
 * below the callback's own entry.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import { resetShellTestState, serveShellRequest } from "../flight.entry.js";
import { createRouter, urls, type HandlerContext } from "../../index.rsc.js";
import { deserializeResult } from "../../cache/segment-codec.js";

const Shell = (_ctx: HandlerContext) => <main>shell</main>;
const Page = () => <p>page</p>;

type Router = Parameters<typeof serveShellRequest>[0];

async function matchedOf(router: Router, url: string): Promise<string[]> {
  const result = await serveShellRequest(router, url);
  return (await deserializeResult<any>(result.flight!)).metadata.matched;
}

beforeEach(() => {
  resetShellTestState();
});

describe("a definition nested under an entry it was not created in", () => {
  it("keeps the layout's segment when the route is created inside the callback", async () => {
    const router = createRouter({}).routes(
      urls(({ path, layout }) => [
        layout(Shell, () => [path("/a", Page, { name: "a" })]),
      ]),
    );
    expect(await matchedOf(router, "/a")).toEqual([
      "M0L0",
      "M0L0L0",
      "M0L0L0R0",
    ]);
  });

  it("rejects a route created above the layout that nests it", () => {
    expect(() =>
      createRouter({}).routes(
        urls(({ path, layout }) => {
          const a = path("/a", Page, { name: "a" });
          return [layout(Shell, () => [a])];
        }),
      ),
    ).toThrow(/route\(\) declared outside the layout\(\) it is nested in/);
  });

  it("rejects a route created above a cache() block that nests it", () => {
    expect(() =>
      createRouter({}).routes(
        urls(({ path, cache }) => {
          const a = path("/a", Page, { name: "a" });
          return [cache({ ttl: 60 }, () => [a])];
        }),
      ),
    ).toThrow(/route\(\) declared outside the cache\(\) it is nested in/);
  });

  it("rejects the same route returned twice, once outside its layout", () => {
    expect(() =>
      createRouter({}).routes(
        urls(({ path, layout }) => {
          const a = path("/a", Page, { name: "a" });
          return [layout(Shell, () => [a]), a];
        }),
      ),
    ).toThrow(/route\(\) declared outside the layout\(\) it is nested in/);
  });

  it("rejects a route created above the orphan cache() marker that lists it", () => {
    expect(() =>
      createRouter({}).routes(
        urls(({ path, cache }) => {
          const a = path("/a", Page, { name: "a" });
          return [cache({ ttl: 60 }), a];
        }),
      ),
    ).toThrow(/route\(\) declared outside the cache\(\) it is nested in/);
  });

  it("rejects the same shape inside a layout's children", () => {
    expect(() =>
      createRouter({}).routes(
        urls(({ path, cache, layout }) => [
          layout(Shell, () => {
            const a = path("/a", Page, { name: "a" });
            return [cache({ ttl: 60 }), a];
          }),
        ]),
      ),
    ).toThrow(/route\(\) declared outside the cache\(\) it is nested in/);
  });

  it("rejects a route created in a nested callback and returned above", () => {
    expect(() =>
      createRouter({}).routes(
        urls(({ path, layout }) => {
          let inner: any;
          return [
            layout(Shell, () => {
              inner = path("/a", Page, { name: "a" });
              return [];
            }),
            inner,
          ];
        }),
      ),
    ).toThrow(/route\(\) declared outside the layout\(\) it is nested in/);
  });

  it("keeps a factory called inside the callback whose list holds its items", async () => {
    const payouts = (helpers: any) => [
      helpers.layout(Shell, () => [helpers.path("/a", Page, { name: "a" })]),
    ];
    const router = createRouter({}).routes(
      urls((helpers) => [payouts(helpers)]),
    );
    expect(await matchedOf(router, "/a")).toEqual([
      "M0L0",
      "M0L0L0",
      "M0L0L0R0",
    ]);
  });

  it("rejects a factory called in another callback", () => {
    const payouts = (helpers: any) => [helpers.path("/a", Page, { name: "a" })];
    expect(() =>
      createRouter({}).routes(
        urls((helpers) => {
          const items = payouts(helpers);
          return [helpers.layout(Shell, () => items)];
        }),
      ),
    ).toThrow(/route\(\) declared outside the layout\(\) it is nested in/);
  });

  it("keeps the orphan cache() form: its following siblings serve inside it", async () => {
    const router = createRouter({}).routes(
      urls(({ path, cache }) => [
        cache({ ttl: 60 }),
        path("/a", Page, { name: "a" }),
        path("/b", Page, { name: "b" }),
      ]),
    );
    expect(await matchedOf(router, "/a")).toEqual([
      "M0L0",
      "M0L0C0",
      "M0L0C0R0",
    ]);
    expect(await matchedOf(router, "/b")).toEqual([
      "M0L0",
      "M0L0C0",
      "M0L0C0R1",
    ]);
  });

  it("keeps a cache() marker called without returning it", async () => {
    const router = createRouter({}).routes(
      urls(({ path, cache }) => {
        cache({ ttl: 60 });
        return [path("/a", Page, { name: "a" })];
      }),
    );
    expect(await matchedOf(router, "/a")).toEqual([
      "M0L0",
      "M0L0C0",
      "M0L0C0R0",
    ]);
  });
});
