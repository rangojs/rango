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
 * them out of order. A streamed route or slot handler gets
 * withSegmentPin(ctx) (router/handler-context.ts), which keeps its own pin.
 * An intercept handler resolves after the main walk, on the shared ctx; the
 * intercept case guards that order.
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
