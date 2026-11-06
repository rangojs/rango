/**
 * The segment a LateHandlePushError names when an async server component the
 * handler handed its ctx to pushes after an `await`, through
 * serveShellRequest.
 *
 * The push is rejected by design (the `.defer()` path is the mitigation), so
 * the message is all a consumer sees of it: it must name the segment whose
 * ctx made the push, not whichever segment the walker pinned last. A route's,
 * a layout's and a parallel slot's ctx each carry their own segment
 * (`withSegmentScope`), so the message names the handler's segment however the
 * component holds the ctx: as the object it calls `ctx.use` on, or as a
 * `use` it destructured off it (`{ use } = ctx`), which keeps the segment
 * through the child's own `use`.
 *
 * The route case is the one the pin cannot cover: the route resolves before
 * its orphan layouts and its parallels, so a route with a slot has a slot's
 * segment pinned by the time its component pushes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import React, { type ReactNode } from "react";

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
  type HandlerContext,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import {
  cachedCrumb,
  cachedCrumbRuns,
} from "./fixtures/streamed-handle-owner-data.js";

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

const errors: string[] = [];

/** An async server component pushing the ctx its handler handed it. */
async function LatePush({
  ctx,
  label,
}: {
  ctx: HandlerContext;
  label: string;
}) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  ctx.use(Crumbs)(label);
  return <span>{label}</span>;
}

/** The same, holding `use` alone, as a destructured ctx hands it on. */
async function LateDetachedPush({
  ctx,
  label,
}: {
  ctx: HandlerContext;
  label: string;
}) {
  const { use } = ctx;
  await new Promise((resolve) => setTimeout(resolve, 0));
  use(Crumbs)(label);
  return <span>{label}</span>;
}

/** The same, holding a spread copy of the ctx, as `{ ...ctx }` hands it on. */
async function LateCopyPush({
  ctx,
  label,
}: {
  ctx: HandlerContext;
  label: string;
}) {
  const copy = { ...ctx };
  await new Promise((resolve) => setTimeout(resolve, 0));
  copy.use(Crumbs)(label);
  return <span>{label}</span>;
}

/**
 * The same, handed `use` as a prop and calling it as `props.use(Handle)`: the
 * call's receiver is the props object, not the ctx.
 */
async function LatePropPush(props: {
  use: HandlerContext["use"];
  label: string;
}) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  props.use(Crumbs)(props.label);
  return <span>{props.label}</span>;
}

/** The same, starting a loader after the `await`; the loader pushes. */
async function LateLoaderPush({
  ctx,
  label,
}: {
  ctx: HandlerContext;
  label: string;
}) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await ctx.use(PushingLoader);
  return <span>{label}</span>;
}

const PushingLoader = createLoader(async (ctx) => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  ctx.use(Crumbs)("loader");
  return "loaded";
});

/** How the component holds the ctx it was handed. */
type Hold = "ctx" | "detached" | "copy" | "prop" | "loader";

const HOLD: Record<
  Hold,
  (props: { ctx: HandlerContext; label: string }) => Promise<ReactNode>
> = {
  ctx: LatePush,
  detached: LateDetachedPush,
  copy: LateCopyPush,
  prop: ({ ctx, label }) => LatePropPush({ use: ctx.use, label }),
  loader: LateLoaderPush,
};

function makeRouter(hold: Hold) {
  const Push = HOLD[hold];
  return createRouter({
    onError: ({ error }) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
  }).routes(
    urls(({ path, layout, parallel, loading }) => [
      layout(
        () => <main>shell</main>,
        () => [
          // Handlers the walker resolves after the route handler: an orphan
          // layout and the route's own slot, beside one more slot after it.
          path(
            "/component-orphan",
            () => <p>page</p>,
            {
              name: "componentOrphan",
            },
            () => [layout((ctx) => <Push ctx={ctx} label="orphan" />)],
          ),
          path(
            "/component-route-slot",
            () => <p>page</p>,
            {
              name: "componentRouteSlot",
            },
            () => [
              parallel({ "@side": (ctx) => <Push ctx={ctx} label="slot" /> }),
              parallel({ "@after": () => <aside>after</aside> }),
            ],
          ),
          // A loading() route streams its handler: the walker resolves its
          // slot while the handler still runs.
          path(
            "/component-streamed",
            async (ctx) => {
              await new Promise((resolve) => setTimeout(resolve, 0));
              return <Push ctx={ctx} label="route" />;
            },
            { name: "componentStreamed" },
            () => [
              loading(<p>loading</p>),
              parallel({ "@aside": () => <aside>aside</aside> }),
            ],
          ),
          layout(
            (ctx) => (
              <div>
                <Push ctx={ctx} label="layout" />
              </div>
            ),
            () => [
              path("/component-layout", () => <p>page</p>, {
                name: "componentLayout",
              }),
            ],
          ),
          layout(
            () => <section>slot frame</section>,
            () => [
              parallel({
                "@panel": (ctx) => <Push ctx={ctx} label="slot" />,
              }),
              path("/component-slot", () => <p>page</p>, {
                name: "componentSlot",
              }),
            ],
          ),
          path("/component", (ctx) => <Push ctx={ctx} label="route" />, {
            name: "component",
          }),
          // A route whose slot resolves after its handler, which is where the
          // shared pin stops being the route's.
          path(
            "/component-with-slot",
            (ctx) => <Push ctx={ctx} label="route" />,
            { name: "componentWithSlot" },
            () => [parallel({ "@aside": () => <aside>aside</aside> })],
          ),
        ],
      ),
    ]),
  );
}

/** The segment ids the response's tree matched. */
async function matchedOf(flight: string | undefined): Promise<string[]> {
  const { metadata } = await deserializeResult<{
    metadata: { matched: string[] };
  }>(flight!);
  return metadata.matched;
}

async function serve(
  url: string,
  hold: Hold,
  mode: "document" | "navigation" = "document",
) {
  errors.length = 0;
  const result = await serveShellRequest(makeRouter(hold), url, {
    cacheStore: new MemorySegmentCacheStore(),
    ...(mode === "navigation" ? { partial: true as const } : {}),
  });
  // A navigation's handles stream after the response: read them to the end,
  // which is after every late push was rejected.
  await result.readHandles();
  return { errors: [...errors], matched: await matchedOf(result.flight) };
}

/** The one LateHandlePushError the response reported, and its segment. */
function latePushSegment(reported: string[]): string {
  expect(reported).toHaveLength(1);
  const segment = /for segment "([^"]+)" was pushed after/.exec(reported[0]!);
  expect(segment).not.toBeNull();
  return segment![1]!;
}

beforeEach(async () => {
  await resetShellTestState();
});

describe("a LateHandlePushError names the segment whose ctx pushed", () => {
  it("the layout's, for a component the layout handler handed its ctx to", async () => {
    const { errors: reported, matched } = await serve(
      "/component-layout",
      "ctx",
    );
    const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    expect(latePushSegment(reported)).toBe(layout);
  });

  it("the slot's, for a component the parallel slot's handler handed its ctx to", async () => {
    const { errors: reported, matched } = await serve("/component-slot", "ctx");
    const slot = matched.find((id) => id.endsWith(".@panel"))!;
    expect(latePushSegment(reported)).toBe(slot);
  });

  it("the route's, for a component the route handler handed its ctx to", async () => {
    const { errors: reported, matched } = await serve("/component", "ctx");
    const route = matched.filter((id) => /R\d+$/.test(id)).at(-1)!;
    expect(latePushSegment(reported)).toBe(route);
  });

  it("the route's, for a route whose slot resolves after its handler", async () => {
    const { errors: reported, matched } = await serve(
      "/component-with-slot",
      "ctx",
    );
    const route = matched.filter((id) => /R\d+$/.test(id)).at(-1)!;
    expect(latePushSegment(reported)).toBe(route);
  });

  it("the layout's, for a component that holds only `use` off the ctx", async () => {
    const { errors: reported, matched } = await serve(
      "/component-layout",
      "detached",
    );
    const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    expect(latePushSegment(reported)).toBe(layout);
  });

  it("the slot's, for a component that holds only `use` off the ctx", async () => {
    const { errors: reported, matched } = await serve(
      "/component-slot",
      "detached",
    );
    const slot = matched.find((id) => id.endsWith(".@panel"))!;
    expect(latePushSegment(reported)).toBe(slot);
  });

  it("the route's, for a component that holds only `use` off the ctx", async () => {
    const { errors: reported, matched } = await serve("/component", "detached");
    const route = matched.filter((id) => /R\d+$/.test(id)).at(-1)!;
    expect(latePushSegment(reported)).toBe(route);
  });

  it("the layout's, for a component that holds a spread copy of the ctx", async () => {
    const { errors: reported, matched } = await serve(
      "/component-layout",
      "copy",
    );
    const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    expect(latePushSegment(reported)).toBe(layout);
  });

  it("the slot's, for a component that holds a spread copy of the ctx", async () => {
    const { errors: reported, matched } = await serve(
      "/component-slot",
      "copy",
    );
    const slot = matched.find((id) => id.endsWith(".@panel"))!;
    expect(latePushSegment(reported)).toBe(slot);
  });

  it("the route's, for a component that holds a spread copy of the ctx", async () => {
    const { errors: reported, matched } = await serve(
      "/component-with-slot",
      "copy",
    );
    const route = matched.filter((id) => /R\d+$/.test(id)).at(-1)!;
    expect(latePushSegment(reported)).toBe(route);
  });

  it("the route's, for a detached `use` and a slot after the handler", async () => {
    const { errors: reported, matched } = await serve(
      "/component-with-slot",
      "detached",
    );
    const route = matched.filter((id) => /R\d+$/.test(id)).at(-1)!;
    expect(latePushSegment(reported)).toBe(route);
  });

  // `props.use(Handle)`: the call's receiver is the props object, so only a
  // `use` that closes over its segment keeps it. A loader the component
  // starts after the `await` is the handler's work too: its push files
  // under the same segment.
  for (const hold of ["prop", "loader"] as const) {
    it(`the layout's, for ${hold === "prop" ? "`props.use(Handle)`" : "a loader the component starts"}`, async () => {
      const { errors: reported, matched } = await serve(
        "/component-layout",
        hold,
      );
      const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
      expect(latePushSegment(reported)).toBe(layout);
    });

    it(`the slot's, for ${hold === "prop" ? "`props.use(Handle)`" : "a loader the component starts"}`, async () => {
      const { errors: reported, matched } = await serve(
        "/component-slot",
        hold,
      );
      const slot = matched.find((id) => id.endsWith(".@panel"))!;
      expect(latePushSegment(reported)).toBe(slot);
    });

    it(`the route's, for ${hold === "prop" ? "`props.use(Handle)`" : "a loader the component starts"} and a slot after the handler`, async () => {
      const { errors: reported, matched } = await serve(
        "/component-with-slot",
        hold,
      );
      const route = matched.filter((id) => /R\d+$/.test(id)).at(-1)!;
      expect(latePushSegment(reported)).toBe(route);
    });
  }
});

describe("a LateHandlePushError from a handler the walker resolves after the route", () => {
  const kinds = [
    [
      "the orphan layout's",
      "/component-orphan",
      (ids: string[]) => ids.filter((id) => /R\d+L\d+$/.test(id)).at(-1)!,
    ],
    [
      "the route slot's",
      "/component-route-slot",
      (ids: string[]) => ids.find((id) => id.endsWith(".@side"))!,
    ],
    [
      "the streamed route's",
      "/component-streamed",
      (ids: string[]) => ids.filter((id) => /R\d+$/.test(id)).at(-1)!,
    ],
  ] as const;
  for (const mode of ["document", "navigation"] as const) {
    for (const [owner, url, segmentOf] of kinds) {
      for (const hold of ["ctx", "detached", "prop", "loader"] as const) {
        it(`names ${owner} segment on a ${mode} (${hold})`, async () => {
          const { errors: reported, matched } = await serve(url, hold, mode);
          expect(latePushSegment(reported)).toBe(segmentOf(matched));
        });
      }
    }
  }
});

/**
 * Each handler's own body calls a "use cache" function with its ctx on the
 * first request, which stores the entry with its push; on the second, a
 * component the handler handed its ctx to calls it after an `await` and
 * HITs. The replayed push is late, and its message must name the segment a
 * MISS's own push names: the handler's.
 */
function cachedRouter(phase: { late: boolean }) {
  async function LateCached({ ctx }: { ctx: HandlerContext }) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await cachedCrumb(ctx, "cached");
    return <span>cached</span>;
  }
  const handler = async (ctx: HandlerContext) => {
    if (!phase.late) await cachedCrumb(ctx, "cached");
    return phase.late ? <LateCached ctx={ctx} /> : <span>warm</span>;
  };
  return createRouter({
    onError: ({ error }) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
  }).routes(
    urls(({ path, layout, parallel }) => [
      layout(
        () => <main>shell</main>,
        () => [
          layout(handler, () => [
            path("/cached-layout", () => <p>page</p>, {
              name: "cachedLayout",
            }),
          ]),
          layout(
            () => <section>slot frame</section>,
            () => [
              parallel({ "@panel": handler }),
              path("/cached-slot", () => <p>page</p>, { name: "cachedSlot" }),
            ],
          ),
          path("/cached-route", handler, { name: "cachedRoute" }, () => [
            parallel({ "@aside": () => <aside>aside</aside> }),
          ]),
        ],
      ),
    ]),
  );
}

describe('a "use cache" HIT a late component makes replays into its segment', () => {
  const cases = [
    [
      "the layout's",
      "/cached-layout",
      (ids: string[]) => ids.filter((id) => /L\d+$/.test(id)).at(-1)!,
    ],
    [
      "the slot's",
      "/cached-slot",
      (ids: string[]) => ids.find((id) => id.endsWith(".@panel"))!,
    ],
    [
      "the route's",
      "/cached-route",
      (ids: string[]) => ids.filter((id) => /R\d+$/.test(id)).at(-1)!,
    ],
  ] as const;
  for (const [owner, url, segmentOf] of cases) {
    it(`${owner}, as its MISS names`, async () => {
      const phase = { late: false };
      const router = cachedRouter(phase);
      const cacheStore = new MemorySegmentCacheStore();
      cachedCrumbRuns.count = 0;
      errors.length = 0;
      await serveShellRequest(router, url, { cacheStore });
      expect(errors).toEqual([]);
      expect(cachedCrumbRuns.count).toBe(1);

      phase.late = true;
      const result = await serveShellRequest(router, url, { cacheStore });
      const matched = await matchedOf(result.flight);
      // The replay is rejected, then the body runs and its own push is
      // rejected too: every message names the handler's segment.
      const named = errors.map(
        (message) =>
          /for segment "([^"]+)" was pushed after/.exec(message)?.[1],
      );
      expect(named.length).toBeGreaterThan(0);
      expect(named).toEqual(named.map(() => segmentOf(matched)));
    });
  }
});

/** An intercept whose handler hands its ctx to a late-pushing component. */
function interceptRouter() {
  return createRouter({
    onError: ({ error }) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
  }).routes(
    urls(({ path, layout, intercept, loading }) => [
      layout(
        () => <main>shell</main>,
        () => [
          path("/list", () => <ul>list</ul>, { name: "list" }),
          path("/item/:id", () => <article>item</article>, { name: "item" }),
          intercept(
            "@modal",
            ".item",
            (ctx) => (
              <dialog>
                <LatePush ctx={ctx} label="intercept" />
              </dialog>
            ),
            () => [loading(<p>modal-loading</p>)],
          ),
        ],
      ),
    ]),
  );
}

describe("a component an intercept handler handed its ctx to", () => {
  it("files its push under the intercept slot, not the route the base ctx carries", async () => {
    const router = interceptRouter();
    const cacheStore = new MemorySegmentCacheStore();
    const list = await serveShellRequest(router, "/list", {
      cacheStore,
      partial: true,
    });
    const { metadata } = await deserializeResult<{
      metadata: { matched: string[] };
    }>(list.flight!);
    errors.length = 0;
    const result = await serveShellRequest(router, "/item/1", {
      cacheStore,
      partial: { from: "/list", segments: metadata.matched },
    });
    // The intercept renders behind the held route, so the push is rejected
    // after the response: the message is the only thing to read.
    expect(latePushSegment([...errors])).toBe("M0L0L0.@modal");
    await result.readHandles();
  });
});

const OrphanLoader = createLoader(async (ctx) => {
  ctx.use(Crumbs)("orphan-loader");
  return "orphan";
});

/**
 * The request's one ctx carries the route's segment once the route handler
 * ran, and the walker starts an orphan layout's DSL loaders after that,
 * through the same ctx: the start must still file the loader's pushes under
 * the orphan.
 */
describe("a DSL loader the walker starts after the route handler", () => {
  for (const mode of ["document", "navigation"] as const) {
    it(`keeps its pushes in its owner's bucket on a ${mode}`, async () => {
      const router = createRouter({}).routes(
        urls(({ path, layout, loader }) => [
          layout(
            () => <main>shell</main>,
            () => [
              path(
                "/owners",
                (ctx) => {
                  ctx.use(Crumbs)("route");
                  return <p>owners</p>;
                },
                { name: "owners" },
                () => [
                  layout(
                    (ctx) => {
                      ctx.use(Crumbs)("orphan");
                      return <section>orphan</section>;
                    },
                    () => [loader(OrphanLoader)],
                  ),
                ],
              ),
            ],
          ),
        ]),
      );
      const result = await serveShellRequest(router, "/owners", {
        cacheStore: new MemorySegmentCacheStore(),
        ...(mode === "navigation" ? { partial: true as const } : {}),
      });
      const { hydration, late } = (await result.readHandles())!;
      const data = late.at(-1) ?? hydration;
      const matched = await matchedOf(result.flight);
      const route = matched.filter((id) => /R\d+$/.test(id)).at(-1)!;
      const orphan = matched.filter((id) => /R\d+L\d+$/.test(id)).at(-1)!;
      expect(data[Crumbs.$$id]).toEqual({
        [route]: ["route"],
        [orphan]: ["orphan-loader", "orphan"],
      });
    });
  }
});
