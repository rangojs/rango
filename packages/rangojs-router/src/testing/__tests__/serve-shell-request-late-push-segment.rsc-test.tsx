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
  type HandlerContext,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import { pushCachedCrumb } from "./fixtures/late-push-segment-data.js";

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

/** How the component holds the ctx it was handed. */
type Hold = "ctx" | "detached" | "copy";

const HOLD = {
  ctx: LatePush,
  detached: LateDetachedPush,
  copy: LateCopyPush,
} as const;

function makeRouter(hold: Hold) {
  const Push = HOLD[hold];
  return createRouter({
    onError: ({ error }) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
  }).routes(
    urls(({ path, layout, parallel }) => [
      layout(
        () => <main>shell</main>,
        () => [
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

async function serve(url: string, hold: Hold) {
  errors.length = 0;
  const result = await serveShellRequest(makeRouter(hold), url, {
    cacheStore: new MemorySegmentCacheStore(),
  });
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

const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/** The segments a response filed `Crumbs` pushes under. */
async function pushedSegments(result: {
  readHandles(): Promise<
    { hydration: Record<string, Record<string, unknown>> } | undefined
  >;
}): Promise<string[]> {
  const handles = await result.readHandles();
  return Object.keys(handles?.hydration[Crumbs.$$id] ?? {});
}

/** A loader whose body pushes a crumb, filed under the segment that owns it. */
const CrumbLoader = createLoader(async (ctx) => {
  ctx.use(Crumbs)("loader");
  return "loaded";
});

/** A component that starts the loader through the ctx its handler handed it. */
async function StartsLoader({
  ctx,
  late,
}: {
  ctx: HandlerContext;
  late: boolean;
}) {
  if (late) await tick();
  await ctx.use(CrumbLoader);
  return <span>loaded</span>;
}

function loaderRouter(late: boolean) {
  return createRouter({
    onError: ({ error }) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
  }).routes(
    urls(({ path, layout, parallel }) => [
      layout(
        () => <main>shell</main>,
        () => [
          layout(
            (ctx) => (
              <div>
                <StartsLoader ctx={ctx} late={late} />
              </div>
            ),
            () => [
              path("/loader-layout", () => <p>page</p>, {
                name: "loaderLayout",
              }),
            ],
          ),
          layout(
            () => <section>slot frame</section>,
            () => [
              parallel({
                "@panel": (ctx) => <StartsLoader ctx={ctx} late={late} />,
              }),
              path("/loader-slot", () => <p>page</p>, { name: "loaderSlot" }),
            ],
          ),
          path(
            "/loader-with-slot",
            (ctx) => <StartsLoader ctx={ctx} late={late} />,
            { name: "loaderWithSlot" },
            () => [parallel({ "@aside": () => <aside>aside</aside> })],
          ),
        ],
      ),
    ]),
  );
}

async function serveLoader(url: string, late: boolean) {
  errors.length = 0;
  const result = await serveShellRequest(loaderRouter(late), url, {
    cacheStore: new MemorySegmentCacheStore(),
  });
  return { result, matched: await matchedOf(result.flight) };
}

describe("a loader a component starts through its handler's ctx", () => {
  it("files its pushes under the layout, not the child route", async () => {
    const { result, matched } = await serveLoader("/loader-layout", false);
    const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    expect(await pushedSegments(result)).toEqual([layout]);
  });

  it("files its pushes under the slot, not the route beside it", async () => {
    const { result, matched } = await serveLoader("/loader-slot", false);
    const slot = matched.find((id) => id.endsWith(".@panel"))!;
    expect(await pushedSegments(result)).toEqual([slot]);
  });

  it("files its pushes under the route, not the route's own slot", async () => {
    const { result, matched } = await serveLoader("/loader-with-slot", false);
    const route = matched.filter((id) => /R\d+$/.test(id)).at(-1)!;
    expect(await pushedSegments(result)).toEqual([route]);
  });

  it("names the layout in the LateHandlePushError of a push after an await", async () => {
    const { result, matched } = await serveLoader("/loader-layout", true);
    await result.readHandles();
    await tick();
    const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    expect(latePushSegment([...errors])).toBe(layout);
  });
});

/** Holds only `use`, borrowed onto another object, as a prop hands it on. */
async function BorrowedPush({ api }: { api: Pick<HandlerContext, "use"> }) {
  await tick();
  api.use(Crumbs)("borrowed");
  return <span>borrowed</span>;
}

describe("a `use` borrowed off a layout's ctx", () => {
  it("names the layout, not the route the walker pinned since", async () => {
    errors.length = 0;
    const router = createRouter({
      onError: ({ error }) => {
        errors.push(error instanceof Error ? error.message : String(error));
      },
    }).routes(
      urls(({ path, layout }) => [
        layout(
          (ctx) => (
            <div>
              <BorrowedPush api={{ use: ctx.use }} />
            </div>
          ),
          () => [path("/borrowed", () => <p>page</p>, { name: "borrowed" })],
        ),
      ]),
    );
    const result = await serveShellRequest(router, "/borrowed", {
      cacheStore: new MemorySegmentCacheStore(),
    });
    const matched = await matchedOf(result.flight);
    await result.readHandles();
    await tick();
    const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    expect(latePushSegment([...errors])).toBe(layout);
  });
});

describe("a spread copy of a handler's ctx", () => {
  it("carries the request's fields for a layout, a slot, a route and an intercept", async () => {
    const copies: Record<string, Partial<HandlerContext>> = {};
    const copy = (kind: string, ctx: HandlerContext) => {
      const { pathname, params, get } = { ...ctx };
      copies[kind] = { pathname, params, get };
    };
    const router = createRouter({}).routes(
      urls(({ path, layout, parallel, intercept }) => [
        layout(
          () => <main>shell</main>,
          () => [
            layout(
              (ctx) => (copy("layout", ctx), (<div />)),
              () => [
                path("/spread-layout", () => <p>page</p>, {
                  name: "spreadLayout",
                }),
              ],
            ),
            layout(
              () => <section>slot frame</section>,
              () => [
                parallel({ "@panel": (ctx) => (copy("slot", ctx), (<i />)) }),
                path("/spread-slot", () => <p>page</p>, { name: "spreadSlot" }),
              ],
            ),
            path("/spread-route", (ctx) => (copy("route", ctx), (<p />)), {
              name: "spreadRoute",
            }),
            path("/list", () => <ul>list</ul>, { name: "list" }),
            path("/item/:id", () => <article>item</article>, { name: "item" }),
            intercept(
              "@modal",
              ".item",
              (ctx) => (copy("intercept", ctx), (<dialog />)),
            ),
          ],
        ),
      ]),
    );
    for (const url of ["/spread-layout", "/spread-slot", "/spread-route"]) {
      await serveShellRequest(router, url, {
        cacheStore: new MemorySegmentCacheStore(),
      });
    }
    const cacheStore = new MemorySegmentCacheStore();
    const list = await serveShellRequest(router, "/list", {
      cacheStore,
      partial: true,
    });
    await serveShellRequest(router, "/item/1", {
      cacheStore,
      partial: { from: "/list", segments: await matchedOf(list.flight) },
    });

    expect(copies.layout).toMatchObject({
      pathname: "/spread-layout",
      params: {},
    });
    expect(copies.slot).toMatchObject({ pathname: "/spread-slot", params: {} });
    expect(copies.route).toMatchObject({
      pathname: "/spread-route",
      params: {},
    });
    expect(copies.intercept).toMatchObject({
      pathname: "/item/1",
      params: { id: "1" },
    });
    for (const kind of ["layout", "slot", "route", "intercept"]) {
      expect(typeof copies[kind]!.get, kind).toBe("function");
    }
  });
});

describe('a "use cache" call through a layout\'s ctx', () => {
  it("replays a HIT's push under the layout, where its MISS filed it", async () => {
    const hold = { late: false };
    /** Calls the cached function after an await, through the layout's ctx. */
    async function LateCachedCall({ ctx }: { ctx: HandlerContext }) {
      await tick();
      await pushCachedCrumb(ctx).catch(() => {});
      return <span>cached</span>;
    }
    const router = createRouter({
      cacheProfiles: { default: { ttl: 60 } },
      onError: ({ error }) => {
        errors.push(error instanceof Error ? error.message : String(error));
      },
    }).routes(
      urls(({ path, layout }) => [
        layout(
          () => <main>shell</main>,
          () => [
            layout(
              async (ctx) => {
                // The first request stores the entry from the handler itself.
                if (!hold.late) {
                  await pushCachedCrumb(ctx);
                  return <div />;
                }
                return (
                  <div>
                    <LateCachedCall ctx={ctx} />
                  </div>
                );
              },
              () => [path("/cached", () => <p>page</p>, { name: "cached" })],
            ),
          ],
        ),
      ]),
    );
    const cacheStore = new MemorySegmentCacheStore();
    const stored = await serveShellRequest(router, "/cached", { cacheStore });
    const layout = (await matchedOf(stored.flight))
      .filter((id) => /L\d+$/.test(id))
      .at(-1)!;
    await stored.readHandles();
    await new Promise((resolve) => setTimeout(resolve, 30));

    hold.late = true;
    errors.length = 0;
    const hit = await serveShellRequest(router, "/cached", { cacheStore });
    await hit.readHandles();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const named = errors.map(
      (message) => /for segment "([^"]+)" was pushed after/.exec(message)?.[1],
    );
    expect(named.length).toBeGreaterThan(0);
    expect(new Set(named)).toEqual(new Set([layout]));
  });
});

describe("a layout with a cached loader", () => {
  it("names the layout: the loader cache's `use` interceptor keeps the ctx a push was made through", async () => {
    errors.length = 0;
    const Plain = createLoader(async () => "plain");
    const router = createRouter({
      onError: ({ error }) => {
        errors.push(error instanceof Error ? error.message : String(error));
      },
    }).routes(
      urls(({ path, layout, loader, cache }) => [
        layout(
          (ctx) => (
            <div>
              <LateDetachedPush ctx={ctx} label="layout" />
            </div>
          ),
          () => [
            loader(Plain, () => [cache({ ttl: 300 })]),
            path("/cached-loader", () => <p>page</p>, {
              name: "cachedLoader",
            }),
          ],
        ),
      ]),
    );
    const result = await serveShellRequest(router, "/cached-loader", {
      cacheStore: new MemorySegmentCacheStore(),
    });
    const matched = await matchedOf(result.flight);
    await result.readHandles();
    await tick();
    const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    expect(latePushSegment([...errors])).toBe(layout);
  });
});
