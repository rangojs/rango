/**
 * The segment a LateHandlePushError names when an async server component the
 * handler handed its ctx to pushes after an `await`, through
 * serveShellRequest.
 *
 * The push is rejected by design (the `.defer()` path is the mitigation), so
 * the message is all a consumer sees of it: it must name the segment whose
 * ctx made the push, not whichever segment the walker pinned last. A layout's
 * or slot's ctx carries its own segment, so the message names it, for a push
 * made through it and for a loader it starts; a route handler's ctx is the
 * request's one ctx, and reads the request's pin, which the walker puts back
 * on the route once the route's parallel slots resolved.
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

const PushLoader = createLoader(async (ctx) => {
  ctx.use(Crumbs)("from-loader");
  return null;
});

/** An async server component starting a loader through the ctx it was handed. */
async function LateStartLoader({ ctx }: { ctx: HandlerContext }) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await ctx.use(PushLoader);
  return <span>loader</span>;
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
            (ctx) => <LatePush ctx={ctx} label="route slot" />,
            { name: "componentRouteSlot" },
            () => [parallel({ "@panel": () => <aside>panel</aside> })],
          ),
          layout(
            (ctx) => <LateStartLoader ctx={ctx} />,
            () => [
              path("/component-layout-loader", () => <p>page</p>, {
                name: "componentLayoutLoader",
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

  it("the route's, not the slot's, after the route's own parallel slot resolved", async () => {
    const { errors: reported, matched } = await serve("/component-route-slot");
    const route = matched.filter((id) => /R\d+$/.test(id)).at(-1)!;
    // The slot handler pins the request's shared segment id while it resolves
    // (resolveParallelSlotComponent); the route's push reads it after that.
    expect(latePushSegment(reported)).toBe(route);
  });

  it("the layout's, for a loader the component the layout handed its ctx to starts", async () => {
    const { errors: reported, matched } = await serve(
      "/component-layout-loader",
    );
    const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    // The loader's own pushes read its owner (loaderOwner), which the calling
    // ctx's carried segment decides.
    expect(latePushSegment(reported)).toBe(layout);
  });
});
