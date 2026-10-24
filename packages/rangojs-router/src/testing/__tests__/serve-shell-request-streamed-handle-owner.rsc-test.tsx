/**
 * Which segment owns a handle push a streamed (`loading()`) handler makes
 * after an `await`, through serveShellRequest: the document and the client
 * navigation, read as `useHandle` collects them (filterSegmentOrder over
 * `matched`, then collectHandleData).
 *
 * The walker pins `_currentSegmentId` on the request's one handler ctx for
 * each segment it resolves, and does not await a streamed handler. Read from
 * the shared ctx after an await, the pin is whatever the walker pinned since:
 * a route's push landed in its slot's bucket, a slot's in the next slot's or
 * the route's, for microtask and timer awaits alike, and `useHandle` showed
 * them out of order. A streamed route or slot handler, and a loader body,
 * run inside their segment's runAsSegment scope (server/context.ts), which
 * their await continuations inherit. A loader a loader body starts after an
 * await files under the starting loader's segment. An intercept handler
 * resolves after the main walk, on the shared ctx; the intercept case guards
 * that order. `{ ...ctx }` in a loading() route copies what it copies in an
 * awaited route.
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
import {
  createHandle,
  createLoader,
  createRouter,
  urls,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import { filterSegmentOrder } from "../../browser/react/filter-segment-order.js";
import { collectHandleData } from "../../handle.js";
import {
  CachedCrumbs,
  cachedCrumb,
  cachedCrumbRuns,
} from "./fixtures/streamed-handle-owner-data.js";

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

type Wait = "3 microtasks" | "8 microtasks" | "a timer";
const WAITS: Wait[] = ["3 microtasks", "8 microtasks", "a timer"];

async function wait(w: Wait): Promise<void> {
  if (w === "a timer") {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return;
  }
  for (let i = w === "3 microtasks" ? 3 : 8; i > 0; i--) {
    await Promise.resolve();
  }
}

const RouteLoader = createLoader(async (ctx) => {
  ctx.use(Crumbs)("loader");
  return null;
});

const InnerLoader = createLoader(async (ctx) => {
  ctx.use(Crumbs)("inner");
  return null;
});

/** Starts InnerLoader from its body after a timer. */
const OuterLoader = createLoader(async (ctx) => {
  await wait("a timer");
  await ctx.use(InnerLoader);
  return null;
});

/**
 * A layout's slot after a route whose loading() handler (`"handler"`) or DSL
 * loader() (`"dsl"`) starts OuterLoader.
 */
function loaderChain(from: "handler" | "dsl") {
  return createRouter({}).routes(
    urls(({ path, layout, parallel, loader, loading }) => [
      layout(
        (ctx) => {
          ctx.use(Crumbs)("layout");
          return <main>shell</main>;
        },
        () => [
          path(
            "/l",
            async (ctx) => {
              if (from === "handler") await ctx.use(OuterLoader);
              else ctx.use(Crumbs)("route");
              return <article>l</article>;
            },
            { name: "l" },
            () => [
              from === "handler"
                ? loading(<p>l-loading</p>)
                : loader(OuterLoader),
              parallel({
                "@side": (ctx) => {
                  ctx.use(Crumbs)("side");
                  return <aside>side</aside>;
                },
              }),
            ],
          ),
        ],
      ),
    ]),
  );
}

/** A loading() route with a slot; the route pushes after `w`. */
function streamedRoute(w: Wait, push: "handle" | "loader" | "bound") {
  return createRouter({}).routes(
    urls(({ path, layout, parallel, loading }) => [
      layout(
        (ctx) => {
          ctx.use(Crumbs)("layout");
          return <main>shell</main>;
        },
        () => [
          path(
            "/a",
            async (ctx) => {
              const bound = ctx.use(Crumbs);
              await wait(w);
              if (push === "handle") ctx.use(Crumbs)("route");
              else if (push === "bound") bound("route");
              else await ctx.use(RouteLoader);
              return <article>a</article>;
            },
            { name: "a" },
            () => [
              loading(<p>a-loading</p>),
              parallel({
                "@side": (ctx) => {
                  ctx.use(Crumbs)("side");
                  return <aside>side</aside>;
                },
              }),
            ],
          ),
        ],
      ),
    ]),
  );
}

/** A loading() slot before a sibling slot and the route. */
function streamedSlot(w: Wait) {
  return createRouter({}).routes(
    urls(({ path, layout, parallel, loading }) => [
      layout(
        (ctx) => {
          ctx.use(Crumbs)("layout");
          return <main>shell</main>;
        },
        () => [
          parallel(
            {
              "@a": async (ctx) => {
                await wait(w);
                ctx.use(Crumbs)("a");
                return <aside>a</aside>;
              },
            },
            () => [loading(<p>a-loading</p>)],
          ),
          parallel({
            "@b": (ctx) => {
              ctx.use(Crumbs)("b");
              return <aside>b</aside>;
            },
          }),
          path(
            "/s",
            (ctx) => {
              ctx.use(Crumbs)("route");
              return <article>s</article>;
            },
            { name: "s" },
          ),
        ],
      ),
    ]),
  );
}

/** A loading() route with a slot; the route calls a "use cache" function that pushes. */
function cachedRoute(w: Wait) {
  return createRouter({}).routes(
    urls(({ path, layout, parallel, loading }) => [
      layout(
        () => <main>shell</main>,
        () => [
          path(
            "/c",
            async (ctx) => {
              await wait(w);
              return <article>{await cachedCrumb(ctx, "route")}</article>;
            },
            { name: "c" },
            () => [
              loading(<p>c-loading</p>),
              parallel({
                "@side": (ctx) => {
                  ctx.use(CachedCrumbs)("side");
                  return <aside>side</aside>;
                },
              }),
            ],
          ),
        ],
      ),
    ]),
  );
}

/** A route whose orphan layout pushes, with no await anywhere. */
function orphanLayout() {
  return createRouter({}).routes(
    urls(({ path, layout, loading }) => [
      layout(
        (ctx) => {
          ctx.use(Crumbs)("layout");
          return <main>shell</main>;
        },
        () => [
          path(
            "/o",
            (ctx) => {
              ctx.use(Crumbs)("route");
              return <article>o</article>;
            },
            { name: "o" },
            () => [
              loading(<p>o-loading</p>),
              layout((ctx) => {
                ctx.use(Crumbs)("orphan");
                return <section>orphan</section>;
              }),
            ],
          ),
        ],
      ),
    ]),
  );
}

type Mode = "document" | "navigation";

type Copy = Record<string, any>;

/**
 * A loading() route and an awaited one that spread their ctx; `/u/:id` hands
 * its copy to a "use cache" call.
 */
function spreadRoutes(copies: Record<"streamed" | "awaited", Copy>) {
  return createRouter({}).routes(
    urls(({ path, loading }) => [
      path(
        "/p/:id",
        async (ctx) => {
          ctx.set("from-ctx", "p");
          copies.streamed = { ...ctx };
          await wait("a timer");
          return <article>p</article>;
        },
        { name: "p" },
        () => [loading(<p>p-loading</p>)],
      ),
      path(
        "/q/:id",
        (ctx) => {
          copies.awaited = { ...ctx };
          return <article>q</article>;
        },
        { name: "q" },
      ),
      path(
        "/u/:id",
        async (ctx) => {
          await wait("a timer");
          return <article>{await cachedCrumb({ ...ctx }, "route")}</article>;
        },
        { name: "u" },
        () => [loading(<p>u-loading</p>)],
      ),
    ]),
  );
}

/** A loading() intercept handler that pushes after `w`, beside a layout slot. */
function streamedIntercept(w: Wait) {
  return createRouter({}).routes(
    urls(({ path, layout, intercept, parallel, loading }) => [
      layout(
        (ctx) => {
          ctx.use(Crumbs)("layout");
          return <main>shell</main>;
        },
        () => [
          parallel({
            "@side": (ctx) => {
              ctx.use(Crumbs)("side");
              return <aside>side</aside>;
            },
          }),
          path("/list", () => <ul>list</ul>, { name: "list" }),
          path("/item/:id", () => <article>item</article>, { name: "item" }),
          intercept(
            "@modal",
            ".item",
            async (ctx) => {
              await wait(w);
              ctx.use(Crumbs)("modal");
              return <dialog>modal</dialog>;
            },
            () => [loading(<p>modal-loading</p>)],
          ),
        ],
      ),
    ]),
  );
}

/** The final handle state a response delivers, and what useHandle collects. */
async function serve(
  router: Parameters<typeof serveShellRequest>[0],
  url: string,
  mode: Mode,
  { handle = Crumbs, cacheStore = new MemorySegmentCacheStore() } = {},
): Promise<{ buckets: Record<string, string[]>; collected: string[] }> {
  const result = await serveShellRequest(router, url, {
    cacheStore,
    ...(mode === "navigation" ? { partial: true as const } : {}),
  });
  const { hydration, late } = (await result.readHandles())!;
  const data = late.at(-1) ?? hydration;
  const { metadata } = await deserializeResult<{
    metadata: { matched: string[] };
  }>(result.flight!);
  return {
    buckets: (data[handle.$$id] ?? {}) as Record<string, string[]>,
    collected: collectHandleData(
      handle,
      data,
      filterSegmentOrder(metadata.matched),
    ) as string[],
  };
}

beforeEach(async () => {
  await resetShellTestState();
});

describe("a streamed intercept handler's push after an await", () => {
  for (const w of WAITS) {
    it(`after ${w}: the push stays in the intercept slot's bucket`, async () => {
      const router = streamedIntercept(w);
      const cacheStore = new MemorySegmentCacheStore();
      const list = await serveShellRequest(router, "/list", {
        cacheStore,
        partial: true,
      });
      const { metadata } = await deserializeResult<{
        metadata: { matched: string[] };
      }>(list.flight!);
      const result = await serveShellRequest(router, "/item/1", {
        cacheStore,
        partial: { from: "/list", segments: metadata.matched },
      });
      const { hydration } = (await result.readHandles())!;
      expect(hydration[Crumbs.$$id]).toEqual({ "M0L0L0.@modal": ["modal"] });
    });
  }
});

describe("{ ...ctx } in a loading() route", () => {
  it("copies the public fields an awaited route's copy has", async () => {
    const copies = {} as Record<"streamed" | "awaited", Copy>;
    const router = spreadRoutes(copies);
    await serve(router, "/p/7", "document");
    await serve(router, "/q/7", "document");
    const { streamed, awaited } = copies;
    const publicKeys = (copy: Copy) =>
      Object.keys(copy).filter((key) => key[0] !== "_");
    expect(publicKeys(streamed)).toEqual(publicKeys(awaited));
    expect(streamed.params).toEqual({ id: "7" });
    expect(streamed.pathname).toBe("/p/7");
    expect((streamed.url as URL).pathname).toBe("/p/7");
    expect(streamed.get("from-ctx")).toBe("p");
    streamed.set("from-copy", "q");
    expect(streamed.get("from-copy")).toBe("q");
    expect(streamed.reverse("p", { id: "8" })).toBe("/p/8");
    expect(streamed.reverse("q", { id: "9" })).toBe("/q/9");
  });

  // The copy keeps the NOCACHE_SYMBOL brand and the _ fields: a ctx to "use cache".
  it('a "use cache" call given the copy is cached and pushes under the route', async () => {
    const router = spreadRoutes({} as Record<"streamed" | "awaited", Copy>);
    const cacheStore = new MemorySegmentCacheStore();
    const options = { handle: CachedCrumbs, cacheStore };
    const runs = cachedCrumbRuns.count;
    const expected = {
      buckets: { M0L0R2: ["route"] },
      collected: ["route"],
    };
    expect(await serve(router, "/u/7", "document", options)).toEqual(expected);
    expect(await serve(router, "/u/7", "document", options)).toEqual(expected);
    expect(cachedCrumbRuns.count - runs).toBe(1);
  });
});

for (const mode of ["document", "navigation"] as const) {
  describe(`a streamed handler's push after an await (${mode})`, () => {
    for (const w of WAITS) {
      describe(`after ${w}`, () => {
        it("a loading() route's push stays in the route's bucket, not its slot's", async () => {
          expect(await serve(streamedRoute(w, "handle"), "/a", mode)).toEqual({
            buckets: {
              M0L0L0: ["layout"],
              M0L0L0R0: ["route"],
              "M0L0L0R0.@side": ["side"],
            },
            collected: ["layout", "route", "side"],
          });
        });

        it("a loader the route starts files its push under the route", async () => {
          expect(await serve(streamedRoute(w, "loader"), "/a", mode)).toEqual({
            buckets: {
              M0L0L0: ["layout"],
              M0L0L0R0: ["loader"],
              "M0L0L0R0.@side": ["side"],
            },
            collected: ["layout", "loader", "side"],
          });
        });

        it("a loading() slot's push stays in its own bucket", async () => {
          expect(await serve(streamedSlot(w), "/s", mode)).toEqual({
            buckets: {
              M0L0L0: ["layout"],
              "M0L0L0.@a": ["a"],
              "M0L0L0.@b": ["b"],
              M0L0L0R0: ["route"],
            },
            collected: ["layout", "a", "b", "route"],
          });
        });

        it('a "use cache" call given the ctx pushes, and replays, under the route', async () => {
          const cacheStore = new MemorySegmentCacheStore();
          const expected = {
            buckets: {
              M0L0L0R0: ["route"],
              "M0L0L0R0.@side": ["side"],
            },
            collected: ["route", "side"],
          };
          const options = { handle: CachedCrumbs, cacheStore };
          // A miss runs the body, the second request replays its record.
          expect(await serve(cachedRoute(w), "/c", mode, options)).toEqual(
            expected,
          );
          expect(await serve(cachedRoute(w), "/c", mode, options)).toEqual(
            expected,
          );
        });

        it("control: a push bound before the await", async () => {
          expect(await serve(streamedRoute(w, "bound"), "/a", mode)).toEqual({
            buckets: {
              M0L0L0: ["layout"],
              M0L0L0R0: ["route"],
              "M0L0L0R0.@side": ["side"],
            },
            collected: ["layout", "route", "side"],
          });
        });
      });
    }

    it("a loader a loading() handler starts, started by its body after an await, files under the route", async () => {
      expect(await serve(loaderChain("handler"), "/l", mode)).toEqual({
        buckets: {
          M0L0L0: ["layout"],
          M0L0L0R0: ["inner"],
          "M0L0L0R0.@side": ["side"],
        },
        collected: ["layout", "inner", "side"],
      });
    });

    it("a loader a DSL loader's body starts after an await files under the route", async () => {
      expect(await serve(loaderChain("dsl"), "/l", mode)).toEqual({
        buckets: {
          M0L0L0: ["layout"],
          M0L0L0R0: ["route", "inner"],
          "M0L0L0R0.@side": ["side"],
        },
        collected: ["layout", "route", "inner", "side"],
      });
    });

    // An orphan layout has no pin of its own: it files under the segment
    // pinned before it. Out of this fix's scope; the case guards that the fix
    // leaves it as it is.
    it("control: an orphan layout's push stays in the route's bucket", async () => {
      expect(await serve(orphanLayout(), "/o", mode)).toEqual({
        buckets: {
          M0L0L0: ["layout"],
          M0L0L0R0: ["route", "orphan"],
        },
        collected: ["layout", "route", "orphan"],
      });
    });
  });
}
