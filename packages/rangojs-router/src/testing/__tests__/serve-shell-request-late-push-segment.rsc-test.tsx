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
 * The call shape must not matter: `const { use } = ctx` and a detached
 * `ctx.use` handed on as a prop are ordinary ways to reach the push, and both
 * still file under the ctx's own segment.
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

/**
 * How the push is reached from the ctx: as a method, destructured off it, or
 * detached from it and handed on as a callback (the shape a component prop
 * takes).
 */
type CallShape = "method" | "destructured" | "detached";

/** An async server component pushing the ctx its handler handed it. */
async function LatePush({
  ctx,
  label,
  shape = "method",
}: {
  ctx: HandlerContext;
  label: string;
  shape?: CallShape;
}) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (shape === "method") {
    ctx.use(Crumbs)(label);
  } else if (shape === "destructured") {
    const { use } = ctx;
    use(Crumbs)(label);
  } else {
    const use = ctx.use;
    use(Crumbs)(label);
  }
  return <span>{label}</span>;
}

function makeRouter(shape?: CallShape) {
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
                <LatePush ctx={ctx} label="layout" shape={shape} />
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

async function serve(url: string, shape?: CallShape) {
  errors.length = 0;
  const result = await serveShellRequest(makeRouter(shape), url, {
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

  // A ctx handed to a component is an ordinary object: the component may
  // destructure the method it needs, or take it as a prop. Neither may change
  // which segment the push names.
  for (const shape of ["destructured", "detached"] as CallShape[]) {
    it(`the layout's, for a ${shape} use the layout handler's ctx reached`, async () => {
      const { errors: reported, matched } = await serve(
        "/component-layout",
        shape,
      );
      const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
      expect(latePushSegment(reported)).toBe(layout);
    });
  }
});
