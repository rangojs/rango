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

async function serve(
  url: string,
  hold: Hold,
  router: Parameters<typeof serveShellRequest>[0] = makeRouter(hold),
) {
  errors.length = 0;
  const result = await serveShellRequest(router, url, {
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

// ---------------------------------------------------------------------------
// The same question for work a handler's ctx STARTS: a loader it reads with
// ctx.use(Loader), whose body pushes, and a "use cache" function it passes the
// ctx to, whose pushes a HIT replays.
// ---------------------------------------------------------------------------

/** A loader a handler's ctx starts; its body pushes at kickoff. */
const StartedData = createLoader(async (ctx) => {
  ctx.use(Crumbs)("from-loader");
  return { started: true };
});

/** The ctx as the component holds it, as LatePush varies it above. */
const START = {
  ctx: (ctx: HandlerContext) => ctx.use,
  detached: (ctx: HandlerContext) => {
    const { use } = ctx;
    return use;
  },
  copy: (ctx: HandlerContext) => {
    const copy = { ...ctx };
    return copy.use;
  },
} as const;

/** An async component starting a loader through the ctx its handler gave it. */
function startsLoader(hold: Hold) {
  const read = START[hold];
  return async function StartsLoader({ ctx }: { ctx: HandlerContext }) {
    const use = read(ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Awaited: the push is rejected (the run is after handle collection) and
    // the router reports it through onError, which is what the test reads.
    await use(StartedData).catch(() => {});
    return <span>starts-loader</span>;
  };
}

/**
 * The segment the loader's own push named: the loader body pushes at kickoff,
 * which is after handle collection here, so the message is all there is.
 */
function loaderPushSegment(reported: string[]): string {
  expect(reported).toHaveLength(1);
  return latePushSegment(reported);
}

function loaderRouter(hold: Hold, kind: "layout" | "route" | "slot") {
  const StartsLoader = startsLoader(hold);
  const onError = ({ error }: { error: unknown }): void => {
    errors.push(error instanceof Error ? error.message : String(error));
  };
  return createRouter({ onError }).routes(
    urls(({ path, layout, parallel }) => [
      layout(
        () => <main>shell</main>,
        () => [
          kind === "layout"
            ? layout(
                (ctx) => (
                  <div>
                    <StartsLoader ctx={ctx} />
                  </div>
                ),
                () => [path("/p", () => <p>page</p>, { name: "p" })],
              )
            : path(
                "/p",
                kind === "route"
                  ? (ctx) => <StartsLoader ctx={ctx} />
                  : () => <p>page</p>,
                { name: "p" },
                kind === "route"
                  ? // A slot resolves after the route handler: the pin stops
                    // being the route's.
                    () => [parallel({ "@aside": () => <aside>aside</aside> })]
                  : () => [
                      parallel({
                        "@panel": (ctx) => <StartsLoader ctx={ctx} />,
                      }),
                    ],
              ),
        ],
      ),
    ]),
  );
}

describe("a loader a handler's ctx starts", () => {
  for (const hold of ["ctx", "detached", "copy"] as const) {
    it(`files its pushes under the layout whose ctx started it (${hold})`, async () => {
      const { errors: reported, matched } = await serve(
        "/p",
        "ctx",
        loaderRouter(hold, "layout"),
      );
      const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
      expect(loaderPushSegment(reported)).toBe(layout);
    });

    it(`files its pushes under the route whose ctx started it (${hold})`, async () => {
      const { errors: reported, matched } = await serve(
        "/p",
        "ctx",
        loaderRouter(hold, "route"),
      );
      const route = matched.filter((id) => /R\d+$/.test(id)).at(-1)!;
      expect(loaderPushSegment(reported)).toBe(route);
    });

    it(`files its pushes under the slot whose ctx started it (${hold})`, async () => {
      const { errors: reported, matched } = await serve(
        "/p",
        "ctx",
        loaderRouter(hold, "slot"),
      );
      const slot = matched.find((id) => id.endsWith(".@panel"))!;
      expect(loaderPushSegment(reported)).toBe(slot);
    });
  }
});

describe('a "use cache" call through a handler\'s ctx', () => {
  it("replays its pushes into the segment the body's own push files under", async () => {
    const { Crumbs: CachedCrumbs, pushCachedCrumbs } =
      await import("./fixtures/late-push-cached-crumbs.js");
    /** The layout's handler pushes, then hands its ctx to a late caller. */
    async function CallsCached({ ctx }: { ctx: HandlerContext }) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await pushCachedCrumbs(ctx, "cached");
      return <span>calls-cached</span>;
    }
    const router = createRouter({
      onError: ({ error }) => {
        errors.push(error instanceof Error ? error.message : String(error));
      },
    }).routes(
      urls(({ path, layout }) => [
        layout(
          () => <main>shell</main>,
          () => [
            layout(
              async (ctx) => (
                <div>
                  {await pushCachedCrumbs(ctx, "cached")}
                  <CallsCached ctx={ctx} />
                </div>
              ),
              () => [path("/p", () => <p>page</p>, { name: "p" })],
            ),
          ],
        ),
      ]),
    );
    errors.length = 0;
    const result = await serveShellRequest(router, "/p", {
      cacheStore: new MemorySegmentCacheStore(),
    });
    const matched = await matchedOf(result.flight);
    const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    // The handler's call runs the body (one push), the component's is a fresh
    // HIT replaying it: both file under the layout whose ctx called them, so
    // the two messages name the same segment.
    expect([...errors].map((message) => latePushSegment([message]))).toEqual([
      layout,
      layout,
    ]);
    expect(CachedCrumbs.$$id).toBeTruthy();
  });
});
