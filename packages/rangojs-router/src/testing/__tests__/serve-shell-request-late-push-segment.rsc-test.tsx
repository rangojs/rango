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
 * The carried segment survives the call shapes a component uses: `ctx.use` as
 * a method and `use` taken off the ctx, and the same push before collection
 * completes files under that segment (not the route's).
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
import { withoutPushedBy } from "../../handles/pushed-by.js";

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

/** The same push through a `use` taken off the ctx, as a component may. */
async function DetachedPush({
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

/** A push made while collection is still open, from the ctx's component. */
function SyncPush({ ctx, label }: { ctx: HandlerContext; label: string }) {
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
            (ctx) => (
              <div>
                <DetachedPush ctx={ctx} label="detached-layout" />
              </div>
            ),
            () => [
              path("/component-detached-layout", () => <p>page</p>, {
                name: "componentDetachedLayout",
              }),
            ],
          ),
          layout(
            () => <section>slot frame</section>,
            () => [
              parallel({
                "@drawer": (ctx) => (
                  <DetachedPush ctx={ctx} label="detached-slot" />
                ),
              }),
              path("/component-detached-slot", () => <p>page</p>, {
                name: "componentDetachedSlot",
              }),
            ],
          ),
          layout(
            (ctx) => {
              ctx.use(Crumbs)("layout-handler");
              return (
                <div>
                  <SyncPush ctx={ctx} label="layout-component" />
                </div>
              );
            },
            () => [
              path(
                "/component-placement",
                (ctx) => {
                  ctx.use(Crumbs)("route-handler");
                  return <p>page</p>;
                },
                { name: "componentPlacement" },
              ),
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
  const result = await serveShellRequest(makeRouter(), url, {
    cacheStore: new MemorySegmentCacheStore(),
  });
  const handles = withoutPushedBy((await result.readHandles())!.hydration);
  return {
    errors: [...errors],
    matched: await matchedOf(result.flight),
    handles,
  };
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

  it("the layout's, for a component that took use off its ctx", async () => {
    const { errors: reported, matched } = await serve(
      "/component-detached-layout",
    );
    const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    expect(latePushSegment(reported)).toBe(layout);
  });

  it("the slot's, for a component that took use off its ctx", async () => {
    const { errors: reported, matched } = await serve(
      "/component-detached-slot",
    );
    const slot = matched.find((id) => id.endsWith(".@drawer"))!;
    expect(latePushSegment(reported)).toBe(slot);
  });
});

describe("a layout's ctx files a component's push under the layout", () => {
  it("before collection completes, beside the layout handler's push", async () => {
    const {
      errors: reported,
      matched,
      handles,
    } = await serve("/component-placement");
    expect(reported).toEqual([]);
    const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    const route = matched.filter((id) => /R\d+$/.test(id)).at(-1)!;
    // The route handler pinned the shared ctx by the time React rendered the
    // layout's component: read from the pin, that push would be the route's.
    expect(handles[Crumbs.$$id]).toEqual({
      [layout]: ["layout-handler", "layout-component"],
      [route]: ["route-handler"],
    });
  });
});
