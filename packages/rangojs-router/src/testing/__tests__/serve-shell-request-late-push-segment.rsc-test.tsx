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
 *
 * The same ctx decides where everything else that ctx starts files: a loader
 * a component starts through it (loaderOwner), and the handle values a
 * "use cache" call made with it replays on a HIT (cache-runtime.ts's caller
 * segment). Both read the segment off the ctx, not the pin, so a layout's or a
 * slot's component reaches its own segment after the walker moved on.
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
import { handleBucketsOf } from "./helpers/handle-buckets.js";

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

/** Every reported LateHandlePushError's segment, in order. */
function latePushSegments(reported: string[]): string[] {
  return reported.map((message) => {
    const segment = /for segment "([^"]+)" was pushed after/.exec(message);
    expect(segment, message).not.toBeNull();
    return segment![1]!;
  });
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

/** A loader a component starts through the ctx its handler handed it. */
const StartedLoader = createLoader(async (ctx) => {
  ctx.use(Crumbs)("started-loader");
  return { ok: true };
});

/** Starts that loader after an await, so its push lands after collection. */
async function LateStart({
  ctx,
  label,
}: {
  ctx: HandlerContext;
  label: string;
}) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await ctx.use(StartedLoader);
  return <span>{label}</span>;
}

/** A "use cache" function pushing with the ctx it is called with. */
async function cachedCrumb(ctx: HandlerContext): Promise<string> {
  "use cache";
  ctx.use(Crumbs)("cached-crumb");
  return "cached";
}

/** Calls it after an await, so the replay lands after collection. */
async function LateCached({ ctx }: { ctx: HandlerContext }) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await cachedCrumb(ctx);
  return <span>cached</span>;
}

/** Where the cached function is called: the handler, or the component. */
let cachedFrom: "handler" | "component" = "handler";

/** A layout and a slot whose handler hands its ctx to a component. */
function startRouter(probe: "loader" | "cached") {
  const After = probe === "loader" ? LateStart : LateCached;
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
                {probe === "cached" && cachedFrom === "handler"
                  ? void cachedCrumb(ctx)
                  : null}
                {probe === "loader" || cachedFrom === "component" ? (
                  <After ctx={ctx} label="layout" />
                ) : null}
              </div>
            ),
            () => [
              path("/start-layout", () => <p>page</p>, { name: "startLayout" }),
            ],
          ),
          layout(
            () => <section>slot frame</section>,
            () => [
              parallel({
                "@panel": (ctx) => (
                  <>
                    {probe === "cached" && cachedFrom === "handler"
                      ? void cachedCrumb(ctx)
                      : null}
                    {probe === "loader" || cachedFrom === "component" ? (
                      <After ctx={ctx} label="slot" />
                    ) : (
                      <aside>slot</aside>
                    )}
                  </>
                ),
              }),
              path("/start-slot", () => <p>page</p>, { name: "startSlot" }),
            ],
          ),
        ],
      ),
    ]),
  );
}

describe("what a layout's or a slot's ctx starts", () => {
  it("a loader started through the layout's ctx files under the layout", async () => {
    errors.length = 0;
    const result = await serveShellRequest(
      startRouter("loader"),
      "/start-layout",
      {
        cacheStore: new MemorySegmentCacheStore(),
      },
    );
    const layout = (await matchedOf(result.flight))
      .filter((id) => /L\d+$/.test(id))
      .at(-1)!;
    // The walker pinned the route before the component pushed.
    expect(latePushSegment([...errors])).toBe(layout);
    await result.readHandles();
  });

  it("a loader started through the slot's ctx files under the slot", async () => {
    errors.length = 0;
    const result = await serveShellRequest(
      startRouter("loader"),
      "/start-slot",
      {
        cacheStore: new MemorySegmentCacheStore(),
      },
    );
    const slot = (await matchedOf(result.flight)).find((id) =>
      id.endsWith(".@panel"),
    )!;
    expect(latePushSegment([...errors])).toBe(slot);
    await result.readHandles();
  });

  it('a "use cache" HIT replays into the layout\'s segment', async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const router = startRouter("cached");
    cachedFrom = "handler";
    // The handler's call records the push with the entry, under the layout.
    const miss = await serveShellRequest(router, "/start-layout", {
      cacheStore,
    });
    const layout = (await matchedOf(miss.flight))
      .filter((id) => /L\d+$/.test(id))
      .at(-1)!;
    expect(await handleBucketsOf(miss)).toEqual({ [layout]: ["cached-crumb"] });
    // The HIT's replay is what the component's call reads.
    cachedFrom = "component";
    errors.length = 0;
    const hit = await serveShellRequest(router, "/start-layout", {
      cacheStore,
    });
    expect(latePushSegments([...errors])).not.toHaveLength(0);
    expect(new Set(latePushSegments([...errors]))).toEqual(new Set([layout]));
    await hit.readHandles();
  });

  it('a "use cache" HIT replays into the slot\'s segment', async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const router = startRouter("cached");
    cachedFrom = "handler";
    const miss = await serveShellRequest(router, "/start-slot", { cacheStore });
    const slot = (await matchedOf(miss.flight)).find((id) =>
      id.endsWith(".@panel"),
    )!;
    expect(await handleBucketsOf(miss)).toEqual({ [slot]: ["cached-crumb"] });
    cachedFrom = "component";
    errors.length = 0;
    const hit = await serveShellRequest(router, "/start-slot", { cacheStore });
    expect(latePushSegments([...errors])).not.toHaveLength(0);
    expect(new Set(latePushSegments([...errors]))).toEqual(new Set([slot]));
    await hit.readHandles();
  });
});
