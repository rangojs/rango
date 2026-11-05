/**
 * The segment a LateHandlePushError names when an async server component the
 * handler handed its ctx to pushes after an `await`, through
 * serveShellRequest.
 *
 * The push is rejected by design (the `.defer()` path is the mitigation), so
 * the message is all a consumer sees of it: it must name the segment whose
 * ctx made the push, not whichever segment the walker pinned last. A layout
 * handler's ctx carries its own segment, so the message names the layout; a
 * route handler's ctx reads the request's pin, which is still the route's.
 *
 * The ctx is the only thing that still says which segment is at fault once the
 * walker moved on, so every way a component can reach it counts: the ctx
 * itself, a `use` destructured off it or handed on as a prop, and a loader the
 * component starts through it.
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
import type { InterceptSelectorContext } from "../../server/context.js";

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

/** Same, through a `use` destructured off the ctx and handed on as a prop. */
async function LatePushDetached({
  use,
  label,
}: {
  use: HandlerContext["use"];
  label: string;
}) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  use(Crumbs)(label);
  return <span>{label}</span>;
}

/** Pushes a handle from its body. */
const BodyLoader = createLoader(async (ctx) => {
  ctx.use(Crumbs)("loader");
  return "loaded";
});

/** Starts a loader through the layout's ctx after an `await`. */
async function LateLoaderStart({ ctx }: { ctx: HandlerContext }) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await ctx.use(BodyLoader);
  return <span>loader</span>;
}

const from =
  (pathname: string) =>
  (ctx: InterceptSelectorContext): boolean =>
    ctx.from.url.pathname === pathname;

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
          layout(
            (ctx) => {
              const { use } = ctx;
              return <LatePushDetached use={use} label="layout-detached" />;
            },
            () => [
              path("/component-layout-detached", () => <p>page</p>, {
                name: "componentLayoutDetached",
              }),
            ],
          ),
          layout(
            () => <section>slot frame</section>,
            () => [
              parallel({
                "@panel": (ctx) => {
                  const { use } = ctx;
                  return <LatePushDetached use={use} label="slot-detached" />;
                },
              }),
              path("/component-slot-detached", () => <p>page</p>, {
                name: "componentSlotDetached",
              }),
            ],
          ),
          path(
            "/component-detached",
            (ctx) => {
              const { use } = ctx;
              return <LatePushDetached use={use} label="route-detached" />;
            },
            { name: "componentDetached" },
          ),
          layout(
            (ctx) => <LateLoaderStart ctx={ctx} />,
            () => [
              path("/component-loader", () => <p>page</p>, {
                name: "componentLoader",
              }),
            ],
          ),
          path("/intercept-source", () => <ul>list</ul>, {
            name: "interceptSource",
          }),
          path("/intercept-target", () => <p>page</p>, {
            name: "interceptTarget",
          }),
          intercept(
            "@modal",
            ".interceptTarget",
            (ctx) => <LatePush ctx={ctx} label="intercept" />,
            { when: from("/intercept-source") },
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

  it("the layout's, for a `use` destructured off the layout handler's ctx", async () => {
    const { errors: reported, matched } = await serve(
      "/component-layout-detached",
    );
    const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    expect(latePushSegment(reported)).toBe(layout);
  });

  it("the slot's, for a `use` destructured off the parallel slot's ctx", async () => {
    const { errors: reported, matched } = await serve(
      "/component-slot-detached",
    );
    const slot = matched.find((id) => id.endsWith(".@panel"))!;
    expect(latePushSegment(reported)).toBe(slot);
  });

  it("the route's, for a `use` destructured off the route handler's ctx", async () => {
    const { errors: reported, matched } = await serve("/component-detached");
    const route = matched.filter((id) => /R\d+$/.test(id)).at(-1)!;
    expect(latePushSegment(reported)).toBe(route);
  });

  it("the layout's, for a loader a component starts through the layout's ctx", async () => {
    const { errors: reported, matched } = await serve("/component-loader");
    const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    expect(latePushSegment(reported)).toBe(layout);
  });

  it("the intercept slot's, for a component the intercept handler handed its ctx to", async () => {
    errors.length = 0;
    const result = await serveShellRequest(makeRouter(), "/intercept-target", {
      cacheStore: new MemorySegmentCacheStore(),
      partial: { from: "/intercept-source", segments: [] },
    });
    const matched = await matchedOf(result.flight);
    const slot = matched.find((id) => id.endsWith(".@modal"))!;
    expect(latePushSegment([...errors])).toBe(slot);
  });
});
