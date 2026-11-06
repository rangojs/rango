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
  createRouter,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import {
  CachedCrumbs,
  cachedCrumb,
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

/** Every LateHandlePushError's segment, in the order the response reported it. */
function latePushSegments(reported: string[]): string[] {
  return reported
    .filter((message) => message.includes(" was pushed after"))
    .map((message) => {
      const segment = /for segment "([^"]+)" was pushed after/.exec(message);
      expect(segment).not.toBeNull();
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

/**
 * Where the layout's / the route's "use cache" call is made: in the handler,
 * so the entry records its push while the store is open, or late in a
 * component, so the next request's HIT replays it after collection.
 */
const cachedCallIn: { value: "handler" | "component" } = { value: "handler" };

/** The same late push, through a "use cache" call taking the ctx. */
async function LateCached({ ctx }: { ctx: HandlerContext }) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  return <span>{await cachedCrumb(ctx, "cached")}</span>;
}

/** A layout's handler and its component, on the same URL and cache key. */
function cachedLayoutRouter() {
  return createRouter({
    onError: ({ error }) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
  }).routes(
    urls(({ path, layout }) => [
      layout(
        () => <main>shell</main>,
        () => [
          layout(
            async (ctx) =>
              cachedCallIn.value === "handler" ? (
                <section>{await cachedCrumb(ctx, "cached")}</section>
              ) : (
                <section>
                  <LateCached ctx={ctx} />
                </section>
              ),
            () => [
              path("/cached-layout", () => <p>page</p>, {
                name: "cachedLayout",
              }),
            ],
          ),
        ],
      ),
    ]),
  );
}

/** A route's handler and its component, with a slot pinned after the route. */
function cachedRouteRouter() {
  return createRouter({
    onError: ({ error }) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
  }).routes(
    urls(({ path, layout, parallel }) => [
      layout(
        () => <main>shell</main>,
        () => [
          path(
            "/cached-route",
            async (ctx) =>
              cachedCallIn.value === "handler" ? (
                <article>{await cachedCrumb(ctx, "cached")}</article>
              ) : (
                <article>
                  <LateCached ctx={ctx} />
                </article>
              ),
            { name: "cachedRoute" },
            () => [parallel({ "@side": () => <aside>side</aside> })],
          ),
        ],
      ),
    ]),
  );
}

/** A response's reported errors, matched ids and cached-crumb buckets. */
async function serveCached(
  router: Parameters<typeof serveShellRequest>[0],
  url: string,
  cacheStore: MemorySegmentCacheStore,
) {
  errors.length = 0;
  const result = await serveShellRequest(router, url, { cacheStore });
  const { hydration, late } = (await result.readHandles())!;
  const data = late.at(-1) ?? hydration;
  return {
    errors: [...errors],
    matched: await matchedOf(result.flight),
    buckets: (data[CachedCrumbs.$$id] ?? {}) as Record<string, string[]>,
  };
}

describe('a "use cache" hit replays under the ctx it was given', () => {
  it("the layout's, when a component calls it with the layout's ctx", async () => {
    const router = cachedLayoutRouter();
    const cacheStore = new MemorySegmentCacheStore();
    cachedCallIn.value = "handler";
    const first = await serveCached(router, "/cached-layout", cacheStore);
    const layout = first.matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    // The fresh run pushes into the layout's bucket...
    expect(first.buckets).toEqual({ [layout]: ["cached"] });
    expect(first.errors).toEqual([]);

    // ...and the HIT replays into the same segment, though the walker pinned
    // the route by the time the component calls it.
    cachedCallIn.value = "component";
    const second = await serveCached(router, "/cached-layout", cacheStore);
    expect(latePushSegments(second.errors)).toEqual([layout, layout]);
  });

  it("the route's, when a component calls it with the route's ctx", async () => {
    const router = cachedRouteRouter();
    const cacheStore = new MemorySegmentCacheStore();
    cachedCallIn.value = "handler";
    const first = await serveCached(router, "/cached-route", cacheStore);
    const route = first.matched.filter((id) => /R\d+$/.test(id)).at(-1)!;
    expect(first.buckets).toEqual({ [route]: ["cached"] });
    expect(first.errors).toEqual([]);

    // The route's slot is pinned after it, so the pin alone would name the slot.
    cachedCallIn.value = "component";
    const second = await serveCached(router, "/cached-route", cacheStore);
    expect(latePushSegments(second.errors)).toEqual([route, route]);
  });
});
