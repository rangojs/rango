/**
 * The segment a LateHandlePushError names when an async server component the
 * handler handed its ctx to pushes after an `await`, through
 * serveShellRequest.
 *
 * The push is rejected by design (the `.defer()` path is the mitigation), so
 * the message is all a consumer sees of it: it must name the segment whose
 * ctx made the push, not whichever segment the walker pinned last. Every
 * handler's ctx carries its own segment (withSegmentScope), so the message
 * names the layout, the slot, the route or the intercept whose handler handed
 * it out — and it still does when the component destructures `use` or copies
 * the ctx with `{ ...ctx }`.
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

import {
  resetShellTestState,
  serveShellRequest,
  type ServeShellRequestResult,
} from "../flight.entry.js";
import {
  createHandle,
  createLoader,
  createRouter,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import type { InterceptSelectorContext } from "../../server/context.js";

const Crumbs = createHandle<string, string[]>();

const errors: string[] = [];

/** The intercept's `when`: the navigation started on `/list`. */
const fromList =
  (pathname: string) =>
  (ctx: InterceptSelectorContext): boolean =>
    ctx.from.url.pathname === pathname;

/** A loader whose body pushes: its push belongs to the loader's segment. */
const LoaderPusher = createLoader(async (ctx) => {
  ctx.use(Crumbs)("from-loader");
  return "loaded";
});

/** An async server component pushing the ctx its handler handed it. */
async function LatePush({
  ctx,
  label,
  shape = "method",
}: {
  ctx: HandlerContext;
  label: string;
  shape?: "method" | "detached" | "spread";
}) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (shape === "detached") {
    const { use } = ctx;
    use(Crumbs)(label);
  } else if (shape === "spread") {
    ({ ...ctx }).use(Crumbs)(label);
  } else {
    ctx.use(Crumbs)(label);
  }
  return <span>{label}</span>;
}

/** An async server component reading a loader through the handler's ctx. */
async function LateLoaderRead({ ctx }: { ctx: HandlerContext }) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  const value = await ctx.use(LoaderPusher);
  return <span>{value}</span>;
}

function makeRouter() {
  return createRouter({
    onError: ({ error }) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
  }).routes(
    urls(({ path, layout, parallel, intercept, loader }) => [
      layout(
        () => <main>shell</main>,
        () => [
          layout(
            (ctx) => (
              <div>
                <LatePush ctx={ctx} label="layout" />
              </div>
            ),
            () => [
              path("/component-layout", () => <p>page</p>, {
                name: "componentLayout",
              }),
            ],
          ),
          layout(
            (ctx) => (
              <div>
                <LatePush ctx={ctx} label="layout" shape="detached" />
              </div>
            ),
            () => [
              path("/component-layout-detached", () => <p>page</p>, {
                name: "componentLayoutDetached",
              }),
            ],
          ),
          layout(
            (ctx) => (
              <div>
                <LatePush ctx={ctx} label="layout" shape="spread" />
              </div>
            ),
            () => [
              path("/component-layout-spread", () => <p>page</p>, {
                name: "componentLayoutSpread",
              }),
            ],
          ),
          layout(
            () => <section>slot frame</section>,
            () => [
              parallel({
                "@panel": (ctx) => <LatePush ctx={ctx} label="slot" />,
              }),
              path("/component-slot", () => <p>page</p>, {
                name: "componentSlot",
              }),
            ],
          ),
          path("/component", (ctx) => <LatePush ctx={ctx} label="route" />, {
            name: "component",
          }),
          path(
            "/component-route-slot",
            (ctx) => <LatePush ctx={ctx} label="route" />,
            { name: "componentRouteSlot" },
            () => [parallel({ "@side": () => <span>side</span> })],
          ),
          path("/list", () => <ul>list</ul>, { name: "list" }),
          path("/item", () => <article>item</article>, { name: "item" }),
          intercept(
            "@modal",
            ".item",
            (ctx) => <LatePush ctx={ctx} label="modal" />,
            { when: fromList("/list") },
          ),
          layout(
            (ctx) => (
              <div>
                <LateLoaderRead ctx={ctx} />
              </div>
            ),
            () => [
              loader(LoaderPusher),
              path("/component-loader", () => <p>page</p>, {
                name: "componentLoader",
              }),
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

async function serve(url: string, partial?: { from: string }) {
  errors.length = 0;
  const result: ServeShellRequestResult = await serveShellRequest(
    makeRouter(),
    url,
    {
      cacheStore: new MemorySegmentCacheStore(),
      ...(partial ? { partial: { from: partial.from } } : {}),
    },
  );
  return {
    errors: [...errors],
    matched: await matchedOf(result.flight),
    handles: await result.readHandles(),
  };
}

/** The one LateHandlePushError the response reported, and its segment. */
function latePushSegment(reported: string[]): string {
  expect(reported).toHaveLength(1);
  const segment = /for segment "([^"]+)" was pushed after/.exec(reported[0]!);
  expect(segment).not.toBeNull();
  return segment![1]!;
}

/** The last matched segment id ending in `suffix` (a layout's `L<n>`, a route's `R<n>`). */
function lastEnding(matched: string[], suffix: RegExp): string {
  const found = matched.filter((id) => suffix.test(id)).at(-1);
  expect(found).toBeDefined();
  return found!;
}

beforeEach(async () => {
  await resetShellTestState();
});

describe("a LateHandlePushError names the segment whose ctx pushed", () => {
  it("the layout's, for a component the layout handler handed its ctx to", async () => {
    const { errors: reported, matched } = await serve("/component-layout");
    expect(latePushSegment(reported)).toBe(lastEnding(matched, /L\d+$/));
  });

  it("the layout's, for a component that destructured ctx.use", async () => {
    const { errors: reported, matched } = await serve(
      "/component-layout-detached",
    );
    expect(latePushSegment(reported)).toBe(lastEnding(matched, /L\d+$/));
  });

  it("the layout's, for a component that copied the ctx with a spread", async () => {
    const { errors: reported, matched } = await serve(
      "/component-layout-spread",
    );
    expect(latePushSegment(reported)).toBe(lastEnding(matched, /L\d+$/));
  });

  it("the slot's, for a component the parallel slot's handler handed its ctx to", async () => {
    const { errors: reported, matched } = await serve("/component-slot");
    expect(latePushSegment(reported)).toBe(
      matched.find((id) => id.endsWith(".@panel")),
    );
  });

  it("the route's, for a component the route handler handed its ctx to", async () => {
    const { errors: reported, matched } = await serve("/component");
    expect(latePushSegment(reported)).toBe(lastEnding(matched, /R\d+$/));
  });

  it("the route's, when the route declares a parallel slot below itself", async () => {
    const { errors: reported, matched } = await serve("/component-route-slot");
    expect(matched.some((id) => id.endsWith(".@side"))).toBe(true);
    expect(latePushSegment(reported)).toBe(lastEnding(matched, /R\d+$/));
  });

  it("the intercept slot's, for a component the intercept's handler handed its ctx to", async () => {
    const { errors: reported, matched } = await serve("/item", {
      from: "/list",
    });
    expect(latePushSegment(reported)).toBe(
      matched.find((id) => id.endsWith(".@modal")),
    );
  });

  it("no error for a loader a component reads through the layout's ctx, and its push stays in the layout's bucket", async () => {
    const {
      errors: reported,
      matched,
      handles,
    } = await serve("/component-loader");
    // A loader's read is not a handle push: the ctx's segment must not move
    // the owner the walker pinned for it (resolveOwnerLoaders), so the push
    // lands in the layout's bucket exactly as it does without a scoped ctx.
    expect(reported).toEqual([]);
    const layout = lastEnding(matched, /L\d+$/);
    expect(matched).toContain(`${layout}D0.${LoaderPusher.$$id}`);
    expect(Object.keys(handles!.hydration[Crumbs.$$id] ?? {})).toEqual([
      layout,
    ]);
  });
});
