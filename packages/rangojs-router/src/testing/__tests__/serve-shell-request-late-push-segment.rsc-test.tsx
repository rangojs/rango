/**
 * The segment a LateHandlePushError names when an async server component the
 * handler handed its ctx to pushes after an `await`, through
 * serveShellRequest.
 *
 * The push is rejected by design (the `.defer()` path is the mitigation), so
 * the message is all a consumer sees of it: it must name the segment whose
 * ctx made the push, not whichever segment the walker pinned last. A layout
 * handler's ctx owns its segment, so the message names the layout; a route
 * handler's ctx reads the request's pin, which is still the route's.
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

/** A loader whose body pushes, started through a layout's ctx after an await. */
const LoaderPush = createLoader(async (ctx) => {
  ctx.use(Crumbs)("loader");
  return null;
});

async function LateLoaderUse({ ctx }: { ctx: HandlerContext }) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await ctx.use(LoaderPush);
  return <span>loader use</span>;
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
          // A route that declares a slot: its handler runs first, the slot's
          // after it, so the shared ctx's pin has moved on by the time the
          // route's own component renders.
          path(
            "/component-slotted",
            (ctx) => (
              <div>
                <LatePush ctx={ctx} label="route with slot" />
              </div>
            ),
            { name: "componentSlotted" },
            () => [parallel({ "@side": () => <p>side</p> })],
          ),
          layout(
            (ctx) => (
              <div>
                <LateLoaderUse ctx={ctx} />
              </div>
            ),
            () => [
              path("/component-loader", () => <p>page</p>, {
                name: "componentLoader",
              }),
            ],
          ),
          layout(
            () => <section>modal frame</section>,
            () => [
              path("/modal-source", () => <p>source</p>, {
                name: "modalSource",
              }),
              path("/intercepted", () => <p>page</p>, { name: "intercepted" }),
              intercept(
                "@modal",
                ".intercepted",
                (ctx) => <LatePush ctx={ctx} label="intercept" />,
                {
                  when: (selector) =>
                    selector.from.url.pathname === "/modal-source",
                },
              ),
            ],
          ),
        ],
      ),
    ]),
  );
}

interface Tree {
  matched: string[];
  segments: Array<{ id: string; namespace?: string }>;
}

/** The segments the response's tree matched and carried. */
async function treeOf(flight: string | undefined): Promise<Tree> {
  const { metadata } = await deserializeResult<{ metadata: Tree }>(flight!);
  return metadata;
}

async function serve(
  url: string,
  partial?: { from?: string; interceptSource?: string },
) {
  errors.length = 0;
  const result = await serveShellRequest(makeRouter(), url, {
    cacheStore: new MemorySegmentCacheStore(),
    ...(partial
      ? {
          partial: {
            from: partial.from ?? "/",
            interceptSource: partial.interceptSource,
          },
        }
      : {}),
  });
  return { errors: [...errors], ...(await treeOf(result.flight)) };
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

  it("the route's, when the route also declares a slot the walk resolves after it", async () => {
    const { errors: reported, matched } = await serve("/component-slotted");
    const route = matched.filter((id) => /R\d+$/.test(id)).at(-1)!;
    // The slot the walk pinned after the handler ran is not the pusher.
    expect(matched).toContain(`${route}.@side`);
    expect(latePushSegment(reported)).toBe(route);
  });

  it("the layout's, for a loader the component starts through its ctx", async () => {
    const { errors: reported, matched } = await serve("/component-loader");
    const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    expect(latePushSegment(reported)).toBe(layout);
  });

  it("the intercept slot's, for a component the intercept handler handed its ctx to", async () => {
    const { errors: reported, segments } = await serve("/intercepted", {
      from: "/modal-source",
      interceptSource: "/modal-source",
    });
    const slot = segments.find((s) => s.namespace?.startsWith("intercept:"))!;
    expect(slot.id).toMatch(/\.@modal$/);
    expect(latePushSegment(reported)).toBe(slot.id);
  });
});
