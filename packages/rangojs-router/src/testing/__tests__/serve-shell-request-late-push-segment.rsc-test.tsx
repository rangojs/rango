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
  type LoaderContext,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";

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
 * The same, with `use` borrowed onto another object and called on it: the
 * receiver is neither the ctx nor absent, and it carries no segment of its
 * own.
 */
async function LateBorrowedPush({
  ctx,
  label,
}: {
  ctx: HandlerContext;
  label: string;
}) {
  const holder = { use: ctx.use };
  await new Promise((resolve) => setTimeout(resolve, 0));
  holder.use(Crumbs)(label);
  return <span>{label}</span>;
}

/** How the component holds the ctx it was handed. */
type Hold = "ctx" | "detached" | "copy" | "borrowed";

const HOLD = {
  ctx: LatePush,
  detached: LateDetachedPush,
  copy: LateCopyPush,
  borrowed: LateBorrowedPush,
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
          // A layout inside a layout: the inner scope's segment must not leak
          // into the outer one's push, or the other way round.
          layout(
            (ctx) => (
              <div>
                <Push ctx={ctx} label="outer" />
              </div>
            ),
            () => [
              layout(
                (ctx) => (
                  <section>
                    <Push ctx={ctx} label="inner" />
                  </section>
                ),
                () => [
                  path("/component-nested", () => <p>page</p>, {
                    name: "componentNested",
                  }),
                ],
              ),
            ],
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

/** Serve one document on `router`, with the errors it reported. */
async function serveOn(
  router: Parameters<typeof serveShellRequest>[0],
  url: string,
) {
  errors.length = 0;
  const result = await serveShellRequest(router, url, {
    cacheStore: new MemorySegmentCacheStore(),
  });
  return { errors: [...errors], matched: await matchedOf(result.flight) };
}

async function serve(url: string, hold: Hold) {
  return serveOn(makeRouter(hold), url);
}

/** The one LateHandlePushError the response reported, and its segment. */
function latePushSegment(reported: string[]): string {
  expect(reported).toHaveLength(1);
  const segment = /for segment "([^"]+)" was pushed after/.exec(reported[0]!);
  expect(segment).not.toBeNull();
  return segment![1]!;
}

/**
 * Every distinct segment the response's LateHandlePushErrors named: one push
 * a "use cache" HIT replays is reported twice (the cache runtime's own report,
 * then the render's).
 */
function latePushSegments(reported: string[]): string[] {
  expect(reported.length).toBeGreaterThan(0);
  return [
    ...new Set(
      reported.map((one) => {
        const segment = /for segment "([^"]+)" was pushed after/.exec(one);
        expect(segment).not.toBeNull();
        return segment![1]!;
      }),
    ),
  ];
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

  it("the layout's, for a `use` borrowed onto another object", async () => {
    const { errors: reported, matched } = await serve(
      "/component-layout",
      "borrowed",
    );
    const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    expect(latePushSegment(reported)).toBe(layout);
  });

  it("the slot's, for a `use` borrowed onto another object", async () => {
    const { errors: reported, matched } = await serve(
      "/component-slot",
      "borrowed",
    );
    const slot = matched.find((id) => id.endsWith(".@panel"))!;
    expect(latePushSegment(reported)).toBe(slot);
  });

  it("the route's, for a `use` borrowed onto another object", async () => {
    const { errors: reported, matched } = await serve(
      "/component-with-slot",
      "borrowed",
    );
    const route = matched.filter((id) => /R\d+$/.test(id)).at(-1)!;
    expect(latePushSegment(reported)).toBe(route);
  });

  it("each nested layout's own, innermost included", async () => {
    const { errors: reported, matched } = await serve(
      "/component-nested",
      "borrowed",
    );
    const layouts = matched.filter((id) => /L\d+$/.test(id)).slice(-2);
    expect(reported.map((one) => latePushSegment([one])).sort()).toEqual(
      layouts.slice().sort(),
    );
  });
});

/** A loader whose body pushes a handle, for the ctx a component starts it through. */
const LateLoader = createLoader(async (loaderCtx) => {
  loaderCtx.use(Crumbs)("loader");
  return { ok: true };
});

/** Starts a loader through the ctx its handler handed it, after an `await`. */
async function LateLoaderStart({ ctx }: { ctx: HandlerContext }) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await ctx.use(LateLoader);
  return <span>loader</span>;
}

/**
 * A router whose layout, slot and route handlers each hand their ctx to a
 * component that starts a loader through it. The loader's push belongs to the
 * segment whose ctx started it, as a handle push through that ctx does.
 */
function loaderRouter() {
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
                <LateLoaderStart ctx={ctx} />
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
              parallel({ "@panel": (ctx) => <LateLoaderStart ctx={ctx} /> }),
              path("/loader-slot", () => <p>page</p>, { name: "loaderSlot" }),
            ],
          ),
          // The route's own ctx, with a slot resolved after its handler.
          path(
            "/loader-route",
            (ctx) => <LateLoaderStart ctx={ctx} />,
            { name: "loaderRoute" },
            () => [parallel({ "@aside": () => <aside>aside</aside> })],
          ),
        ],
      ),
    ]),
  );
}

describe("a loader a component started through a handler's ctx", () => {
  const serveLoader = (url: string) => serveOn(loaderRouter(), url);

  it("files its push under the layout's segment", async () => {
    const { errors: reported, matched } = await serveLoader("/loader-layout");
    const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    expect(latePushSegment(reported)).toBe(layout);
  });

  it("files its push under the slot's segment", async () => {
    const { errors: reported, matched } = await serveLoader("/loader-slot");
    const slot = matched.find((id) => id.endsWith(".@panel"))!;
    expect(latePushSegment(reported)).toBe(slot);
  });

  it("files its push under the route's segment, not the slot's", async () => {
    const { errors: reported, matched } = await serveLoader("/loader-route");
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

/**
 * A "use cache" function that takes the handler's ctx and pushes a handle
 * through it: the push is recorded on the MISS and replayed into the caller's
 * segment on the HIT (cache-runtime.ts callerSegmentId).
 */
async function cachedCrumb(
  ctx: HandlerContext | LoaderContext,
): Promise<string> {
  "use cache";
  ctx.use(Crumbs)("cached");
  return "cached";
}

/** Runs the cached function from a loader, so a component's call HITs it. */
const WarmCrumb = createLoader(async (ctx: LoaderContext) => {
  await cachedCrumb(ctx);
  return { warm: true };
});

/** Calls the cached function after an `await`, through the handler's ctx. */
async function LateCachedPush({ ctx }: { ctx: HandlerContext }) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await cachedCrumb(ctx);
  return <span>cached</span>;
}

/**
 * A layout, a parallel slot and a route-with-its-own-slot that each hand their
 * ctx to a component calling the cached function after the handler returned,
 * where only the ctx says which segment the replay belongs to.
 */
function cachedRouter() {
  return createRouter({
    onError: ({ error }) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
  }).routes(
    urls(({ path, layout, parallel, loader }) => [
      layout(
        () => <main>shell</main>,
        () => [
          layout(
            (ctx) => (
              <div>
                <LateCachedPush ctx={ctx} />
              </div>
            ),
            () => [
              loader(WarmCrumb),
              path("/cached-layout", () => <p>page</p>, {
                name: "cachedLayout",
              }),
            ],
          ),
          layout(
            () => <section>slot frame</section>,
            () => [
              loader(WarmCrumb),
              parallel({
                "@panel": (ctx) => <LateCachedPush ctx={ctx} />,
              }),
              path("/cached-slot", () => <p>page</p>, {
                name: "cachedSlot",
              }),
            ],
          ),
          path(
            "/cached-route",
            (ctx) => <LateCachedPush ctx={ctx} />,
            { name: "cachedRoute" },
            () => [
              loader(WarmCrumb),
              parallel({ "@aside": () => <aside>aside</aside> }),
            ],
          ),
        ],
      ),
    ]),
  );
}

describe('a "use cache" HIT of a call through a handler\'s ctx', () => {
  const serveCached = (url: string) => serveOn(cachedRouter(), url);

  it("replays its push into the layout's segment", async () => {
    const { errors: reported, matched } = await serveCached("/cached-layout");
    const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    expect(latePushSegments(reported)).toEqual([layout]);
  });

  it("replays its push into the slot's segment", async () => {
    const { errors: reported, matched } = await serveCached("/cached-slot");
    const slot = matched.find((id) => id.endsWith(".@panel"))!;
    expect(latePushSegments(reported)).toEqual([slot]);
  });

  it("replays its push into the route's segment, not the slot's", async () => {
    const { errors: reported, matched } = await serveCached("/cached-route");
    const route = matched.filter((id) => /R\d+$/.test(id)).at(-1)!;
    expect(latePushSegments(reported)).toEqual([route]);
  });
});

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
