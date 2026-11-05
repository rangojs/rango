/**
 * The segment a LateHandlePushError names when an async server component the
 * handler handed its ctx to pushes after an `await`, through
 * serveShellRequest.
 *
 * The push is rejected by design (the `.defer()` path is the mitigation), so
 * the message is all a consumer sees of it: it must name the segment whose
 * ctx made the push, not whichever segment the walker pinned last. A layout's,
 * a parallel slot's and an intercept slot's handler ctx carries its own
 * segment, so the message names that segment; a route handler's ctx reads the
 * request's pin, which is still the route's.
 *
 * The ctx's `use` holds in every call shape a component can give it —
 * destructured off the ctx, passed as a prop, bound — because the segment sits
 * in the function's closure, not in `this` (withSegmentScope,
 * router/handler-context.ts). A `this`-based read would name the child route
 * again for all three.
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
  type ServeShellRequestOptions,
} from "../flight.entry.js";
import {
  createHandle,
  createRouter,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

const errors: string[] = [];

const onError = ({ error }: { error: unknown }) => {
  errors.push(error instanceof Error ? error.message : String(error));
};

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

/** How the component holds the push function it got from the ctx. */
type Shape = "detached" | "prop";

/**
 * The same late push, with `use` held the way the shape says: `detached`
 * destructures it off the ctx, `prop` passes it down as a prop.
 */
async function LatePushShape({
  ctx,
  shape,
  label,
}: {
  ctx: HandlerContext;
  shape: Shape;
  label: string;
}) {
  const push = shape === "detached" ? (({ use }) => use)(ctx) : ctx.use;
  await new Promise((resolve) => setTimeout(resolve, 0));
  push(Crumbs)(label);
  return <span>{label}</span>;
}

function makeRouter() {
  return createRouter({ onError }).routes(
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
                <LatePushShape ctx={ctx} shape="detached" label="detached" />
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
                <LatePushShape ctx={ctx} shape="prop" label="propped" />
              </div>
            ),
            () => [
              path("/component-layout-prop", () => <p>page</p>, {
                name: "componentLayoutProp",
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
            () => <section>detached slot frame</section>,
            () => [
              parallel({
                "@detached": (ctx) => (
                  <LatePushShape
                    ctx={ctx}
                    shape="detached"
                    label="slot-detached"
                  />
                ),
              }),
              path("/component-slot-detached", () => <p>page</p>, {
                name: "componentSlotDetached",
              }),
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

/** An intercept's slot handler handing its ctx to a component. */
function makeInterceptRouter() {
  return createRouter({ onError }).routes(
    urls(({ path, layout, intercept }) => [
      layout(
        () => <main>shell</main>,
        () => [
          path("/list", () => <ul>list</ul>, { name: "list" }),
          path("/item/:id", () => <p>item</p>, { name: "item" }),
          intercept("@modal", ".item", (ctx) => (
            <LatePush ctx={ctx} label="modal" />
          )),
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
  {
    router = makeRouter(),
    partial,
  }: {
    router?: Parameters<typeof serveShellRequest>[0];
    partial?: ServeShellRequestOptions["partial"];
  } = {},
) {
  errors.length = 0;
  const result = await serveShellRequest(router, url, {
    cacheStore: new MemorySegmentCacheStore(),
    ...(partial ? { partial } : {}),
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

  it("the layout's when the component destructures `use` off the ctx", async () => {
    const { errors: reported, matched } = await serve(
      "/component-layout-detached",
    );
    const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    expect(latePushSegment(reported)).toBe(layout);
  });

  it("the layout's when the component gets `ctx.use` as a prop", async () => {
    const { errors: reported, matched } = await serve("/component-layout-prop");
    const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    expect(latePushSegment(reported)).toBe(layout);
  });

  it("the slot's, for a component the parallel slot's handler handed its ctx to", async () => {
    const { errors: reported, matched } = await serve("/component-slot");
    const slot = matched.find((id) => id.endsWith(".@panel"))!;
    expect(latePushSegment(reported)).toBe(slot);
  });

  it("the slot's when the component destructures `use` off the ctx", async () => {
    const { errors: reported, matched } = await serve(
      "/component-slot-detached",
    );
    const slot = matched.find((id) => id.endsWith(".@detached"))!;
    expect(latePushSegment(reported)).toBe(slot);
  });

  it("the intercept slot's, for a component its handler handed the ctx to", async () => {
    const { errors: reported, matched } = await serve("/item/1", {
      router: makeInterceptRouter(),
      partial: { from: "/list", segments: [] },
    });
    const slot = matched.find((id) => id.endsWith(".@modal"))!;
    expect(latePushSegment(reported)).toBe(slot);
  });

  it("the route's, for a component the route handler handed its ctx to", async () => {
    const { errors: reported, matched } = await serve("/component");
    const route = matched.filter((id) => /R\d+$/.test(id)).at(-1)!;
    expect(latePushSegment(reported)).toBe(route);
  });
});
