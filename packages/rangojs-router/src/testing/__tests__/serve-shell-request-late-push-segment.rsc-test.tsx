/**
 * The segment a push through a layout's or a parallel slot's ctx belongs to,
 * when an async server component the handler handed its ctx to makes it,
 * through serveShellRequest.
 *
 * The walker moves the shared `_currentSegmentId` on after a handler returns,
 * so the ctx has to carry its own segment: an accepted push files under it,
 * and a rejected one (by design, the `.defer()` path is the mitigation) names
 * it in the dev LateHandlePushError, which is all a consumer sees of it.
 * However the component reaches `ctx.use` — detached, through a `{ ...ctx }`
 * copy, after an `await` — the message and the bucket stay the same; a route
 * handler's ctx is the request's one ctx and reads the walker's pin.
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
import { callShapes } from "./helpers/call-shapes.js";

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

const errors: string[] = [];
/** The message each call shape's push ended with, by `<label>:<shape>`. */
const shapeResults: Record<string, string> = {};

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

/** The same push, made through a detached `const { use } = ctx`. */
async function LatePushDetached({
  ctx,
  label,
}: {
  ctx: HandlerContext;
  label: string;
}) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  const { use } = ctx;
  use(Crumbs)(label);
  return <span>{label}</span>;
}

/** The same push, made through every ordinary call shape of `ctx.use`. */
async function LatePushShapes({
  ctx,
  label,
}: {
  ctx: HandlerContext;
  label: string;
}) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const shape of callShapes(ctx, "use")) {
    const key = `${label}:${shape.name}`;
    try {
      const push = (await shape.call(Crumbs)) as (value: string) => void;
      push(label);
      shapeResults[key] = "pushed";
    } catch (error) {
      shapeResults[key] = (error as Error).message;
    }
  }
  return <span>{label}</span>;
}

/** A component that pushes while it renders, before collection completes. */
function EarlyPush({ ctx, label }: { ctx: HandlerContext; label: string }) {
  ctx.use(Crumbs)(label);
  return <span>{label}</span>;
}

function makeRouter() {
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
                <LatePushShapes ctx={ctx} label="layout" />
              </div>
            ),
            () => [
              path("/shapes-layout", () => <p>page</p>, {
                name: "shapesLayout",
              }),
            ],
          ),
          layout(
            (ctx) => (
              <div>
                <EarlyPush ctx={ctx} label="layout" />
              </div>
            ),
            () => [
              path("/early-layout", () => <p>page</p>, {
                name: "earlyLayout",
              }),
            ],
          ),
          layout(
            (ctx) => (
              <div>
                <LatePushDetached ctx={ctx} label="layout" />
              </div>
            ),
            () => [
              path("/detached-layout", () => <p>page</p>, {
                name: "detachedLayout",
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
          layout(
            () => <section>slot frame</section>,
            () => [
              parallel({
                "@panel": (ctx) => <LatePushShapes ctx={ctx} label="slot" />,
              }),
              path("/shapes-slot", () => <p>page</p>, { name: "shapesSlot" }),
            ],
          ),
          layout(
            () => <section>slot frame</section>,
            () => [
              parallel({
                "@panel": (ctx) => <EarlyPush ctx={ctx} label="slot" />,
              }),
              path("/early-slot", () => <p>page</p>, { name: "earlySlot" }),
            ],
          ),
          path("/component", (ctx) => <LatePush ctx={ctx} label="route" />, {
            name: "component",
          }),
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
  for (const key of Object.keys(shapeResults)) delete shapeResults[key];
  const result = await serveShellRequest(makeRouter(), url, {
    cacheStore: new MemorySegmentCacheStore(),
  });
  const handles = (await result.readHandles())!;
  return {
    errors: [...errors],
    matched: await matchedOf(result.flight),
    shapeResults: { ...shapeResults },
    /** The segments the accepted pushes filed under. */
    buckets: Object.keys(handles.hydration[Crumbs.$$id] ?? {}),
  };
}

/** Serve `from` as a document, then `to` as a partial navigation from it. */
async function serveNavigation(from: string, to: string) {
  const router = makeRouter();
  const cacheStore = new MemorySegmentCacheStore();
  const start = await serveShellRequest(router, from, {
    cacheStore,
    partial: { from },
  });
  const held = await matchedOf(start.flight);
  errors.length = 0;
  const navigation = await serveShellRequest(router, to, {
    cacheStore,
    partial: { from, segments: held },
  });
  return {
    errors: [...errors],
    matched: await matchedOf(navigation.flight),
  };
}

/** The one LateHandlePushError the response reported, and its segment. */
function latePushSegment(reported: string[]): string {
  expect(reported).toHaveLength(1);
  const segment = /for segment "([^"]+)" was pushed after/.exec(reported[0]!);
  expect(segment).not.toBeNull();
  return segment![1]!;
}

/** The layout id the response's deepest layout segment matched. */
function layoutOf(matched: string[]): string {
  return matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
}

/** The `@panel` slot id the response's tree matched. */
function slotOf(matched: string[]): string {
  return matched.find((id) => id.endsWith(".@panel"))!;
}

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
    expect(latePushSegment(reported)).toBe(slotOf(matched));
  });

  it("the route's, for a component the route handler handed its ctx to", async () => {
    const { errors: reported, matched } = await serve("/component");
    const route = matched.filter((id) => /R\d+$/.test(id)).at(-1)!;
    expect(latePushSegment(reported)).toBe(route);
  });

  it("the layout's, however the component calls ctx.use", async () => {
    const { shapeResults: results, matched } = await serve("/shapes-layout");
    const layout = layoutOf(matched);
    expect(Object.keys(results)).toHaveLength(6);
    for (const [key, message] of Object.entries(results)) {
      expect(message, key).toContain(
        `for segment "${layout}" was pushed after`,
      );
    }
  });

  it("the layout's, for a detached use, on a navigation", async () => {
    const { errors: reported, matched } = await serveNavigation(
      "/component",
      "/detached-layout",
    );
    expect(latePushSegment(reported)).toBe(layoutOf(matched));
  });

  it("the slot's, however the component calls ctx.use", async () => {
    const { shapeResults: results, matched } = await serve("/shapes-slot");
    const slot = slotOf(matched);
    expect(Object.keys(results)).toHaveLength(6);
    for (const [key, message] of Object.entries(results)) {
      expect(message, key).toContain(`for segment "${slot}" was pushed after`);
    }
  });
});

describe("an accepted push through a layout's or a slot's ctx files under that segment", () => {
  it("the layout's, for a component the layout handler handed its ctx to", async () => {
    const { buckets, matched } = await serve("/early-layout");
    expect(buckets).toEqual([layoutOf(matched)]);
  });

  it("the slot's, for a component the parallel slot's handler handed its ctx to", async () => {
    const { buckets, matched } = await serve("/early-slot");
    expect(buckets).toEqual([slotOf(matched)]);
  });
});
