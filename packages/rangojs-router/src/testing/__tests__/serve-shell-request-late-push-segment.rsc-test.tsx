/**
 * The segment a LateHandlePushError names when an async server component the
 * handler handed its ctx to pushes after an `await`, through
 * serveShellRequest.
 *
 * The push is rejected by design (the `.defer()` path is the mitigation), so
 * the message is all a consumer sees of it: it must name the segment whose
 * ctx made the push, not whichever segment the walker pinned last. A layout's,
 * a slot's, a route's and an intercept's ctx carries its own segment, so the
 * message names that segment however the component reached `use` (called on
 * the ctx, destructured off it) and whether the walker resolved a sibling
 * slot or an orphan layout since.
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

const wait = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/** An async server component pushing the ctx its handler handed it. */
async function LatePush({
  ctx,
  label,
}: {
  ctx: HandlerContext;
  label: string;
}) {
  await wait();
  ctx.use(Crumbs)(label);
  return <span>{label}</span>;
}

/** The same push through a destructured `use`, as a component may hold it. */
async function DetachedPush({ ctx }: { ctx: HandlerContext }) {
  await wait();
  const { use } = ctx;
  use(Crumbs)("detached");
  return <span>detached</span>;
}

const PanelLoader = createLoader(async (ctx) => {
  ctx.use(Crumbs)("panel-loader");
  return { panel: true };
});

/** An async component that starts a loader through the ctx it was handed. */
async function StartsLoader({ ctx }: { ctx: HandlerContext }) {
  await wait();
  // The push inside the loader is the late one; its rejection is reported
  // through onError like any other late push.
  await ctx.use(PanelLoader).catch(() => {});
  return <span>panel</span>;
}

const OrphanLoader = createLoader(async () => ({ orphan: true }));

function makeRouter() {
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
          layout(
            (ctx) => (
              <div>
                <DetachedPush ctx={ctx} />
              </div>
            ),
            () => [
              path("/component-detached", () => <p>page</p>, {
                name: "componentDetached",
              }),
            ],
          ),
          // A sibling slot the walker resolves after the route handler ran.
          path(
            "/component-route-slot",
            (ctx) => <LatePush ctx={ctx} label="route" />,
            { name: "componentRouteSlot" },
            () => [
              parallel({
                "@side": (ctx) => {
                  ctx.use(Crumbs)("side");
                  return <aside>side</aside>;
                },
              }),
            ],
          ),
          // An orphan layout under the route, resolved after its handler.
          path(
            "/component-orphan",
            (ctx) => <LatePush ctx={ctx} label="route" />,
            { name: "componentOrphan" },
            () => [
              layout(
                () => <nav>orphan</nav>,
                () => [loader(OrphanLoader)],
              ),
            ],
          ),
          layout(
            (ctx) => (
              <div>
                <StartsLoader ctx={ctx} />
              </div>
            ),
            () => [
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

function makeInterceptRouter() {
  return createRouter({
    onError: ({ error }) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
  }).routes(
    urls(({ path, layout, intercept }) => [
      layout(
        (ctx) => {
          ctx.use(Crumbs)("layout");
          return <main>shell</main>;
        },
        () => [
          path("/list", () => <ul>list</ul>, { name: "list" }),
          path("/item/:id", () => <article>item</article>, { name: "item" }),
          intercept("@modal", ".item", (ctx) => (
            <LatePush ctx={ctx} label="intercept" />
          )),
        ],
      ),
    ]),
  );
}

interface Answer {
  metadata: { matched: string[] };
}

/** The segment ids the response's tree matched. */
async function matchedOf(flight: string | undefined): Promise<string[]> {
  const { metadata } = await deserializeResult<Answer>(flight!);
  return metadata.matched;
}

async function serve(url: string) {
  errors.length = 0;
  const result = await serveShellRequest(makeRouter(), url, {
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
    const { errors: reported, matched } = await serve("/component-layout");
    const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    expect(latePushSegment(reported)).toBe(layout);
  });

  it("the slot's, for a component the parallel slot's handler handed its ctx to", async () => {
    const { errors: reported, matched } = await serve("/component-slot");
    const slot = matched.find((id) => id.endsWith(".@panel"))!;
    expect(latePushSegment(reported)).toBe(slot);
  });

  it("the route's, for a component the route handler handed its ctx to", async () => {
    const { errors: reported, matched } = await serve("/component");
    const route = matched.filter((id) => /R\d+$/.test(id)).at(-1)!;
    expect(latePushSegment(reported)).toBe(route);
  });

  it("the layout's, for a destructured `use` off the ctx the layout handler handed out", async () => {
    const { errors: reported, matched } = await serve("/component-detached");
    const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    expect(latePushSegment(reported)).toBe(layout);
  });

  it("the route's, though a sibling slot resolved after the route handler", async () => {
    const { errors: reported, matched } = await serve("/component-route-slot");
    const route = matched.filter((id) => /R\d+$/.test(id)).at(-1)!;
    expect(latePushSegment(reported)).toBe(route);
  });

  it("the route's, though an orphan layout under it resolved after its handler", async () => {
    const { errors: reported, matched } = await serve("/component-orphan");
    const route = matched.filter((id) => /R\d+$/.test(id)).at(-1)!;
    expect(latePushSegment(reported)).toBe(route);
  });

  it("the layout's, for a loader a component the layout handler handed its ctx to starts", async () => {
    const { errors: reported, matched } = await serve("/component-loader");
    const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    expect(latePushSegment(reported)).toBe(layout);
  });

  it("the slot's, for a component the intercept handler handed its ctx to", async () => {
    const router = makeInterceptRouter();
    const cacheStore = new MemorySegmentCacheStore();
    const source = await serveShellRequest(router, "/list", {
      cacheStore,
      partial: true,
    });
    const segments = await matchedOf(source.flight);
    errors.length = 0;
    const result = await serveShellRequest(router, "/item/1", {
      cacheStore,
      partial: { from: "/list", segments },
    });
    const slot = (await matchedOf(result.flight)).find((id) =>
      id.endsWith(".@modal"),
    )!;
    expect(latePushSegment([...errors])).toBe(slot);
  });
});
