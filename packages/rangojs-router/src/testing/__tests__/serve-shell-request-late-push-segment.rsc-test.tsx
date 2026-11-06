/**
 * The segment a LateHandlePushError names when an async server component the
 * handler handed its ctx to pushes after an `await`, through
 * serveShellRequest.
 *
 * The push is rejected by design (the `.defer()` path is the mitigation), so
 * the message is all a consumer sees of it: it must name the segment whose
 * ctx made the push, not whichever segment the walker pinned last. A layout's,
 * a parallel slot's and a route's ctx each answer for themselves — the first
 * two carry their segment (`_handleSegmentId`, withSegmentScope), the route's
 * is the request's one ctx, whose pin the walker puts back once the slots
 * below the route have run.
 *
 * Every ordinary call shape is probed (helpers/call-shapes.ts): a component
 * may destructure `use` or spread-copy the ctx, and a fix that only resolves
 * the segment from the receiver passes the method call and fails those.
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
import { callShapes, type CallShapeName } from "./helpers/call-shapes.js";
import {
  expectNoInternalFields,
  serveEveryShape,
} from "./helpers/response-shapes.js";

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

const errors: string[] = [];

/** A call shape that could not reach `ctx.use` at all (a spread copy without one). */
const shapeErrors: string[] = [];

/** How the component calls `ctx.use`, set by the test that serves it. */
let shape: CallShapeName = "method";

/** An async server component pushing the ctx its handler handed it. */
async function LatePush({
  ctx,
  label,
}: {
  ctx: HandlerContext;
  label: string;
}) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  const one = callShapes(ctx as unknown as { use: unknown }, "use").find(
    (s) => s.name === shape,
  )!;
  let push: (value: unknown) => void;
  try {
    push = (await one.call(Crumbs)) as (value: unknown) => void;
  } catch (error) {
    shapeErrors.push(`${label} [${shape}] ${(error as Error).message}`);
    return <span>{label}</span>;
  }
  // The late push is rejected by design; that rejection is what the message
  // under test is. Only reaching `use` at all is the shape's own contract.
  try {
    push(label);
  } catch {
    // Reported through onError.
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
          // The slot below the route runs after the route's handler, and it is
          // the last thing the walker pins: the route's ctx must still name
          // the route.
          path(
            "/component-route-slot",
            (ctx) => <LatePush ctx={ctx} label="route-slot" />,
            { name: "componentRouteSlot" },
            () => [
              parallel({
                "@side": () => <aside>side</aside>,
              }),
            ],
          ),
          path("/list", () => <ul>list</ul>, { name: "list" }),
          path("/item/:id", () => <article>item</article>, { name: "item" }),
          // The intercept's handler gets the shared ctx and its slot is the
          // last thing the walker pins, so the push names the slot.
          intercept("@modal", ".item", (ctx) => (
            <dialog>
              <LatePush ctx={ctx} label="intercept" />
            </dialog>
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

async function serve(url: string, from?: string) {
  errors.length = 0;
  shapeErrors.length = 0;
  const router = makeRouter();
  const cacheStore = new MemorySegmentCacheStore();
  let partial: { from: string; segments: string[] } | undefined;
  if (from !== undefined) {
    const page = await serveShellRequest(router, from, {
      cacheStore,
      partial: true,
    });
    partial = { from, segments: await matchedOf(page.flight) };
  }
  const result = await serveShellRequest(router, url, {
    cacheStore,
    partial,
  });
  return {
    errors: [...errors],
    matched: await matchedOf(result.flight),
    shapeErrors: [...shapeErrors],
  };
}

/** The one LateHandlePushError the response reported, and its segment. */
function latePushSegment(reported: string[]): string {
  expect(reported).toHaveLength(1);
  const segment = /for segment "([^"]+)" was pushed after/.exec(reported[0]!);
  expect(segment).not.toBeNull();
  return segment![1]!;
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
  shape = "method";
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

  it("the route's, for a route that declares a slot below itself", async () => {
    const { errors: reported, matched } = await serve("/component-route-slot");
    const route = matched.filter((id) => /R\d+$/.test(id)).at(-1)!;
    // The slot ran last, and its segment is in the tree: the push must not
    // have followed it.
    expect(matched.some((id) => id.endsWith(".@side"))).toBe(true);
    expect(latePushSegment(reported)).toBe(route);
  });
});

describe("every ordinary call shape names the segment whose ctx pushed", () => {
  for (const row of [
    {
      name: "layout",
      url: "/component-layout",
      segmentOf: (matched: string[]) =>
        matched.filter((id) => /L\d+$/.test(id)).at(-1)!,
    },
    {
      name: "parallel slot",
      url: "/component-slot",
      segmentOf: (matched: string[]) =>
        matched.find((id) => id.endsWith(".@panel"))!,
    },
    {
      name: "route",
      url: "/component",
      segmentOf: (matched: string[]) =>
        matched.filter((id) => /R\d+$/.test(id)).at(-1)!,
    },
    {
      name: "route with its own slot",
      url: "/component-route-slot",
      segmentOf: (matched: string[]) =>
        matched.filter((id) => /R\d+$/.test(id)).at(-1)!,
    },
    {
      name: "intercept",
      url: "/item/1",
      from: "/list",
      segmentOf: (matched: string[]) =>
        matched.find((id) => id.endsWith(".@modal"))!,
    },
  ]) {
    for (const one of SHAPES) {
      it(`${row.name}: ${one}`, async () => {
        shape = one;
        const {
          errors: reported,
          matched,
          shapeErrors: thrown,
        } = await serve(row.url, (row as { from?: string }).from);
        expect(thrown).toEqual([]);
        expect(latePushSegment(reported)).toBe(row.segmentOf(matched));
      });
    }
  }
});

/**
 * A stored record, a replayed one and an intercept slot are the shapes a fix
 * like this leaks through. `cache()` on the layout's entry makes the handler
 * run once and every later request replay its record; the intercept opens a
 * slot over the same route.
 */
function makeCachedRouter() {
  return createRouter({
    onError: ({ error }) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
  }).routes(
    urls(({ path, layout, cache, intercept }) => [
      layout(
        () => <main>shell</main>,
        () => [
          path("/start", () => <p>start</p>, { name: "start" }),
          cache({ ttl: 600 }, () => [
            layout(
              (ctx) => (
                <div>
                  <LatePush ctx={ctx} label="cached-layout" />
                </div>
              ),
              () => [
                path("/cached/:id", () => <p>cached</p>, { name: "cached" }),
                intercept("@modal", ".cached", () => <dialog>modal</dialog>),
              ],
            ),
          ]),
        ],
      ),
    ]),
  );
}

describe("the segment holds on every served shape", () => {
  it("document, partial, cache HIT and intercept: the layout's, and no internal field", async () => {
    errors.length = 0;
    shapeErrors.length = 0;
    const shapes = await serveEveryShape(makeCachedRouter(), {
      from: "/start",
      to: "/cached/1",
      intercept: { next: "/cached/2" },
    });

    // Every shape that ran the layout's handler reported the layout, never the
    // route below it; a HIT replays the stored record and runs nothing.
    const layoutIds = new Set<string>();
    for (const shape of shapes) {
      for (const id of await matchedOf(shape.result.flight)) {
        if (/L\d+$/.test(id)) layoutIds.add(id);
      }
    }
    const layout = [...layoutIds].at(-1)!;
    expect(errors.length).toBeGreaterThan(0);
    for (const message of errors) {
      expect(message).toContain(`for segment "${layout}" was pushed after`);
    }
    expect(shapeErrors).toEqual([]);
    expectNoInternalFields(shapes);
  });
});
