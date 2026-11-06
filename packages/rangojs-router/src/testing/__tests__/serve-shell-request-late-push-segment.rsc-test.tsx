/**
 * The segment a LateHandlePushError names when an async server component the
 * handler handed its ctx to pushes after an `await`, through
 * serveShellRequest.
 *
 * The push is rejected by design (the `.defer()` path is the mitigation), so
 * the message is all a consumer sees of it: it must name the segment whose
 * ctx made the push, not whichever segment the walker pinned last. A layout
 * handler's ctx carries its own segment, so the message names the layout; a
 * route handler's ctx is the request's one ctx, and the walk restores the pin
 * to the route after the route's own slots resolve. A loader a component
 * starts through a handed ctx files its pushes under that ctx's segment too.
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

/** An async server component destructuring `use` off the ctx it was handed. */
async function LatePushDetached({
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

/** A loader pushing its own crumb: started through a ctx handed to a component. */
const CrumbLoader = createLoader(async (ctx) => {
  ctx.use(Crumbs)("from loader");
  return "loaded";
});

/** An async server component starting a loader through the ctx it was handed. */
async function LateLoaderPush({
  ctx,
  label,
}: {
  ctx: HandlerContext;
  label: string;
}) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  const value = await ctx.use(CrumbLoader);
  return <span>{`${label} ${value}`}</span>;
}

function makeRouter() {
  return createRouter({
    onError: ({ error }) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
  }).routes(
    urls(({ path, layout, parallel, intercept }) => [
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
          // A route with a parallel slot: the slot's resolution moves the
          // request's pin on after the route handler returned, and the route
          // handler's ctx is that shared one.
          path(
            "/component-route-slot",
            (ctx) => <LatePush ctx={ctx} label="route" />,
            { name: "componentRouteSlot" },
            () => [parallel({ "@panel": () => <p>panel</p> })],
          ),
          layout(
            (ctx) => <LateLoaderPush ctx={ctx} label="layout loader" />,
            () => [
              path("/component-loader-layout", () => <p>page</p>, {
                name: "componentLoaderLayout",
              }),
            ],
          ),
          layout(
            () => <section>slot frame</section>,
            () => [
              parallel({
                "@panel": (ctx) => (
                  <LateLoaderPush ctx={ctx} label="slot loader" />
                ),
              }),
              path("/component-loader-slot", () => <p>page</p>, {
                name: "componentLoaderSlot",
              }),
            ],
          ),
          layout(
            (ctx) => <LatePushDetached ctx={ctx} label="layout detached" />,
            () => [
              path("/component-detached", () => <p>page</p>, {
                name: "componentDetached",
              }),
            ],
          ),
          // An intercept renders into a parallel slot of the route it targets.
          path("/list", () => <p>list</p>, { name: "list" }),
          path("/item", () => <p>item</p>, { name: "item" }),
          intercept(
            "@modal",
            ".item",
            (ctx) => <LatePush ctx={ctx} label="intercept" />,
            {
              when: (ctx) => ctx.from.url.pathname === "/list",
            },
            () => [],
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
  options?: { partial?: { from: string; segments: string[] } },
) {
  errors.length = 0;
  const result = await serveShellRequest(makeRouter(), url, {
    cacheStore: new MemorySegmentCacheStore(),
    ...options,
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

  it("the route's, for a component the route handler handed its ctx to, with a parallel slot on the route", async () => {
    const { errors: reported, matched } = await serve("/component-route-slot");
    const route = matched.filter((id) => /R\d+$/.test(id)).at(-1)!;
    expect(latePushSegment(reported)).toBe(route);
  });

  it("the layout's, for a loader a component the layout handler handed its ctx to starts", async () => {
    const { errors: reported, matched } = await serve(
      "/component-loader-layout",
    );
    const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    expect(latePushSegment(reported)).toBe(layout);
  });

  it("the slot's, for a loader a component the slot handler handed its ctx to starts", async () => {
    const { errors: reported, matched } = await serve("/component-loader-slot");
    const slot = matched.find((id) => id.endsWith(".@panel"))!;
    expect(latePushSegment(reported)).toBe(slot);
  });

  it("the layout's, for a component that destructured `use` off the layout's ctx", async () => {
    const { errors: reported, matched } = await serve("/component-detached");
    const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    expect(latePushSegment(reported)).toBe(layout);
  });

  it("the intercept slot's, for a component the intercept's handler handed its ctx to", async () => {
    const { errors: reported, matched } = await serve("/item", {
      partial: { from: "/list", segments: [] },
    });
    const slot = matched.find((id) => id.endsWith(".@modal"))!;
    expect(latePushSegment(reported)).toBe(slot);
  });
});
