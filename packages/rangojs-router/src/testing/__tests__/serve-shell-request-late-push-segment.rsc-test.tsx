/**
 * The segment a LateHandlePushError names when an async server component the
 * handler handed its ctx to pushes after an `await`, through
 * serveShellRequest.
 *
 * The push is rejected by design (the `.defer()` path is the mitigation), so
 * the message is all a consumer sees of it: it must name the segment whose
 * ctx made the push, not whichever segment the walker pinned last. A layout's
 * or parallel slot's ctx carries its own segment, so the message names the
 * layout or the slot; a route handler's ctx reads the request's pin, which is
 * still the route's.
 *
 * The segment has to hold however the consumer calls the method: a detached
 * `const { use } = ctx`, a `{ ...ctx }` copy, and either after an `await`
 * included (call-shapes.ts). An intercept's handler ctx carries its slot the
 * same way.
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
import { callShapes, type CallShapeName } from "./helpers/call-shapes.js";

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

const errors: string[] = [];

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** `ctx.use(Crumbs)` in one ordinary call shape, then the push. */
async function pushInShape(
  ctx: HandlerContext,
  shape: CallShapeName,
  label: string,
): Promise<void> {
  const shapeOf = callShapes(ctx as any, "use").find((s) => s.name === shape)!;
  const push = (await shapeOf.call(Crumbs)) as (v: string[]) => void;
  push([label]);
}

/** An async server component pushing the ctx its handler handed it. */
async function LatePush({
  ctx,
  label,
  shape = "method",
}: {
  ctx: HandlerContext;
  label: string;
  shape?: CallShapeName;
}) {
  await tick();
  await pushInShape(ctx, shape, label);
  return <span>{label}</span>;
}

/** A loader body that pushes through its own ctx after an `await`. */
const BodyLoader = createLoader(async (ctx: any) => {
  await tick();
  ctx.use(Crumbs)(["loader"]);
  return "body";
});

/** An async server component starting a loader through its handler's ctx. */
async function LateLoaderPush({ ctx }: { ctx: HandlerContext }) {
  await tick();
  await ctx.use(BodyLoader);
  return <span>loader</span>;
}

/** The call shape the URL asks for, `method` when it asks for none. */
function shapeOf(ctx: HandlerContext): CallShapeName {
  const params = ctx.params as Record<string, string | undefined> | undefined;
  return (params?.shape ?? "method") as CallShapeName;
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
                <LatePush ctx={ctx} label="layout" shape={shapeOf(ctx)} />
              </div>
            ),
            () => [
              path("/component-layout", () => <p>page</p>, {
                name: "componentLayout",
              }),
              path("/component-layout-shape/:shape", () => <p>page</p>, {
                name: "componentLayoutShape",
              }),
            ],
          ),
          layout(
            () => <section>slot frame</section>,
            () => [
              parallel({
                "@panel": (ctx) => (
                  <LatePush ctx={ctx} label="slot" shape={shapeOf(ctx)} />
                ),
              }),
              path("/component-slot", () => <p>page</p>, {
                name: "componentSlot",
              }),
              path("/component-slot-shape/:shape", () => <p>page</p>, {
                name: "componentSlotShape",
              }),
            ],
          ),
          path("/component", (ctx) => <LatePush ctx={ctx} label="route" />, {
            name: "component",
          }),
          path("/component-intercept-source", () => <p>source</p>, {
            name: "interceptSource",
          }),
          path("/component-intercepted/:shape", () => <p>page</p>, {
            name: "intercepted",
          }),
          intercept(
            "@modal",
            ".intercepted",
            (ctx) => (
              <LatePush ctx={ctx} label="intercept" shape={shapeOf(ctx)} />
            ),
            { when: (ctx: any) => ctx.from.routeName === "interceptSource" },
          ),
          layout(
            (ctx) => <LateLoaderPush ctx={ctx} />,
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

/** The layout's own segment id in the response's matched list. */
function layoutOf(matched: string[]): string {
  return matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
}

const SHAPES: CallShapeName[] = [
  "method",
  "detached",
  "spread",
  "spread detached",
  "after await",
  "after await detached",
];

beforeEach(async () => {
  await resetShellTestState();
});

describe("a LateHandlePushError names the segment whose ctx pushed", () => {
  it("the layout's, for a component the layout handler handed its ctx to", async () => {
    const { errors: reported, matched } = await serve("/component-layout");
    expect(latePushSegment(reported)).toBe(layoutOf(matched));
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

  it("the layout's, however the component calls ctx.use", async () => {
    for (const shape of SHAPES) {
      const { errors: reported, matched } = await serve(
        `/component-layout-shape/${encodeURIComponent(shape)}`,
      );
      expect({ shape, segment: latePushSegment(reported) }).toEqual({
        shape,
        segment: layoutOf(matched),
      });
    }
  });

  it("the slot's, however the component calls ctx.use", async () => {
    for (const shape of SHAPES) {
      const { errors: reported, matched } = await serve(
        `/component-slot-shape/${encodeURIComponent(shape)}`,
      );
      const slot = matched.find((id) => id.endsWith(".@panel"))!;
      expect({ shape, segment: latePushSegment(reported) }).toEqual({
        shape,
        segment: slot,
      });
    }
  });

  it("the intercept's, for a component the intercept handler handed its ctx to", async () => {
    const router = makeRouter();
    const store = new MemorySegmentCacheStore();
    const source = await serveShellRequest(
      router,
      "/component-intercept-source",
      {
        cacheStore: store,
      },
    );
    errors.length = 0;
    const opened = await serveShellRequest(
      router,
      "/component-intercepted/method",
      {
        cacheStore: store,
        partial: {
          from: "/component-intercept-source",
          segments: await matchedOf(source.flight),
        },
      },
    );
    const matched = await matchedOf(opened.flight);
    const slot = matched.find((id) => id.endsWith(".@modal"))!;
    expect(slot).toBeDefined();
    expect(latePushSegment(errors)).toBe(slot);
  });

  it("the layout's, for a loader the component starts through that ctx", async () => {
    const { errors: reported, matched } = await serve("/component-loader");
    expect(latePushSegment(reported)).toBe(layoutOf(matched));
  });
});
