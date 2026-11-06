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
 * The segment travels as a value the ctx's own `use` hands over
 * (withSegmentScope), so a `use` destructured off the ctx names it too, and a
 * ctx nested in another's (a layout inside a layout) names its own.
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

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

const errors: string[] = [];

/** How a component gets the push function off the ctx it was handed. */
type Via = "method" | "destructured" | "mapped";

/**
 * An async server component pushing the ctx its handler handed it, after an
 * await. A ctx is an object whose `use` is a property: `via` says how it was
 * obtained, and every shape must name the same segment. `mapped` hands `use`
 * to `Array.prototype.map`, which calls it with (item, index, array) — the
 * index is not a segment.
 */
async function LatePush({
  ctx,
  label,
  via = "method",
}: {
  ctx: HandlerContext;
  label: string;
  via?: Via;
}) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (via === "destructured") {
    const { use } = ctx;
    use(Crumbs)(label);
  } else if (via === "mapped") {
    const push = [Crumbs].map(ctx.use as any)[0]! as (value: string) => void;
    push(label);
  } else {
    ctx.use(Crumbs)(label);
  }
  return <span>{label}</span>;
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
          path(
            "/component-mapped",
            (ctx) => <LatePush ctx={ctx} label="mapped" via="mapped" />,
            { name: "componentMapped" },
          ),
          layout(
            (ctx) => (
              <LatePush ctx={ctx} label="detached-layout" via="destructured" />
            ),
            () => [
              path("/detached-layout", () => <p>page</p>, {
                name: "detachedLayout",
              }),
            ],
          ),
          layout(
            () => <section>detached slot frame</section>,
            () => [
              parallel({
                "@panel": (ctx) => (
                  <LatePush
                    ctx={ctx}
                    label="detached-slot"
                    via="destructured"
                  />
                ),
              }),
              path("/detached-slot", () => <p>page</p>, {
                name: "detachedSlot",
              }),
            ],
          ),
          layout(
            (ctx) => <LatePush ctx={ctx} label="outer" />,
            () => [
              layout(
                (ctx) => <LatePush ctx={ctx} label="inner" />,
                () => [path("/nested", () => <p>page</p>, { name: "nested" })],
              ),
            ],
          ),
          layout(
            () => <section>intercept frame</section>,
            () => [
              path("/list", () => <p>list</p>, { name: "list" }),
              path("/intercepted", () => <p>page</p>, {
                name: "intercepted",
              }),
              intercept("@modal", ".intercepted", (ctx) => (
                <LatePush ctx={ctx} label="intercept" />
              )),
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
  const result = await serveShellRequest(makeRouter(), url, {
    cacheStore: new MemorySegmentCacheStore(),
    ...(partial && { partial }),
  });
  return { errors: [...errors], matched: await matchedOf(result.flight) };
}

/** The segments the response's LateHandlePushErrors named, in order. */
function latePushSegments(reported: string[]): string[] {
  return reported.map((message) => {
    const segment = /for segment "([^"]+)" was pushed after/.exec(message);
    expect(segment).not.toBeNull();
    return segment![1]!;
  });
}

/** The one LateHandlePushError the response reported, and its segment. */
function latePushSegment(reported: string[]): string {
  expect(reported).toHaveLength(1);
  return latePushSegments(reported)[0]!;
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

  it("the route's, for a `use` its caller's own arguments reach", async () => {
    const { errors: reported, matched } = await serve("/component-mapped");
    const route = matched.filter((id) => /R\d+$/.test(id)).at(-1)!;
    expect(latePushSegment(reported)).toBe(route);
  });

  it("the layout's, for a `use` destructured off the layout's ctx", async () => {
    const { errors: reported, matched } = await serve("/detached-layout");
    const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    expect(latePushSegment(reported)).toBe(layout);
  });

  it("the slot's, for a `use` destructured off the slot's ctx", async () => {
    const { errors: reported, matched } = await serve("/detached-slot");
    const slot = matched.find((id) => id.endsWith(".@panel"))!;
    expect(latePushSegment(reported)).toBe(slot);
  });

  it("each layout's own, for a layout nested in a layout", async () => {
    const { errors: reported, matched } = await serve("/nested");
    // The two layouts that handed a ctx out, outermost first (the shell
    // layouts above them push nothing).
    const layouts = matched.filter((id) => /L\d+$/.test(id)).slice(-2);
    expect(latePushSegments(reported)).toEqual(layouts);
  });

  it("the intercept slot's, for a component the intercept's handler handed its ctx to", async () => {
    // An intercept opens on a navigation from the page it lands over.
    await serve("/list");
    const { errors: reported, matched } = await serve("/intercepted", {
      from: "/list",
    });
    const slot = matched.find((id) => id.endsWith(".@modal"))!;
    expect(latePushSegment(reported)).toBe(slot);
  });
});
