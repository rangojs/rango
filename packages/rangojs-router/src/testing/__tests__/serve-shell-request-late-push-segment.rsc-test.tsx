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

type PushProps = { ctx: HandlerContext; label: string };

/** An async server component pushing the ctx its handler handed it. */
async function LatePush({ ctx, label }: PushProps) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  ctx.use(Crumbs)(label);
  return <span>{label}</span>;
}

/** The same, with the method taken off the ctx first. */
async function LatePushDetached({ ctx, label }: PushProps) {
  const { use } = ctx;
  await new Promise((resolve) => setTimeout(resolve, 0));
  use(Crumbs)(label);
  return <span>{label}</span>;
}

/** The same, with the method handed on as a callback. */
async function LatePushCallback({ ctx, label }: PushProps) {
  const push = [ctx.use].map((use) => use(Crumbs))[0]!;
  await new Promise((resolve) => setTimeout(resolve, 0));
  push(label);
  return <span>{label}</span>;
}

function makeRouter(
  component: (props: PushProps) => React.ReactNode = LatePush,
) {
  const Push = component;
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
                <Push ctx={ctx} label="layout" />
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
                "@panel": (ctx) => <Push ctx={ctx} label="slot" />,
              }),
              path("/component-slot", () => <p>page</p>, {
                name: "componentSlot",
              }),
            ],
          ),
          path("/component", (ctx) => <Push ctx={ctx} label="route" />, {
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

async function serve(
  url: string,
  component?: (props: PushProps) => React.ReactNode,
) {
  errors.length = 0;
  const result = await serveShellRequest(makeRouter(component), url, {
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
});

// The segment does not depend on how the component reaches the method: taking
// `use` off the ctx or handing it to a callback must name the same segment a
// method call does.
describe("a LateHandlePushError names the same segment for every call shape", () => {
  const shapes = [
    { name: "a destructured `use`", component: LatePushDetached },
    { name: "a `use` passed as a callback", component: LatePushCallback },
  ];

  for (const shape of shapes) {
    it(`the layout's, for ${shape.name}`, async () => {
      const { errors: reported, matched } = await serve(
        "/component-layout",
        shape.component,
      );
      const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
      expect(latePushSegment(reported)).toBe(layout);
    });

    it(`the slot's, for ${shape.name}`, async () => {
      const { errors: reported, matched } = await serve(
        "/component-slot",
        shape.component,
      );
      const slot = matched.find((id) => id.endsWith(".@panel"))!;
      expect(latePushSegment(reported)).toBe(slot);
    });
  }
});
