/**
 * The segment a LateHandlePushError names when a component a handler handed
 * its ctx to pushes a handle after an `await`, through serveShellRequest.
 *
 * The push is rejected by design (the `.defer()` path is the mitigation), so
 * the message is all a consumer sees of it: it must name the segment whose
 * ctx made the push, not whichever segment the walker pinned last. A handler
 * ctx carries its own segment (`withSegmentScope`), so the message names the
 * layout, the slot or the intercept whose handler handed the ctx over, and a
 * route's shared ctx names the route.
 *
 * The row per handler kind is the point: the reported case was a layout, and
 * a fix that only taught `ctx.use` to read its receiver still failed for
 * `const { use } = ctx`, for a `{ ...ctx }` copy, for a route with its own
 * parallel slot (whose handler pinned last) and for a loader a component
 * starts through the ctx. `callShapes` runs every ordinary call shape.
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
import { cachedCrumb } from "./fixtures/streamed-handle-owner-data.js";

const Crumbs = createHandle<string, string[]>(() => []);

/** A loader the component starts through the ctx it was handed. */
const Pushed = createLoader(async (ctx) => {
  ctx.use(Crumbs)("from-loader");
  return "loaded";
});

const errors: string[] = [];

type Row =
  | "layout"
  | "parallel slot"
  | "route"
  | "route with its own slot"
  | "intercept"
  | "loader"
  | "use cache";

/** The call shapes `ctx.use` is probed in; a `"use cache"` call has none. */
const SHAPES: CallShapeName[] = [
  "method",
  "detached",
  "spread",
  "spread detached",
  "after await",
  "after await detached",
];

/**
 * A component the handler hands its ctx to: it renders after the handler
 * returned and after handle collection completed, then pushes in `shape`.
 */
function probe(row: Row, shape: CallShapeName) {
  return async function Probe({ ctx }: { ctx: HandlerContext }) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (row === "use cache") {
      await cachedCrumb(ctx, "from-cache");
      return <span>{row}</span>;
    }
    const call = callShapes(
      ctx as unknown as Record<string, unknown>,
      "use",
    ).find((s) => s.name === shape)!;
    const returned = (await call.call(row === "loader" ? Pushed : Crumbs)) as
      | ((value: string) => void)
      | Promise<unknown>;
    if (row === "loader") {
      await (returned as Promise<unknown>);
    } else {
      (returned as (value: string) => void)(shape);
    }
    return <span>{row}</span>;
  };
}

function makeRouter(row: Row, shape: CallShapeName) {
  const Probe = probe(row, shape);
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
            (ctx) => <Probe ctx={ctx} />,
            () => [path("/component-layout", () => <p>page</p>, { name: "l" })],
          ),
          layout(
            () => <section>slot frame</section>,
            () => [
              parallel({ "@panel": (ctx) => <Probe ctx={ctx} /> }),
              path("/component-slot", () => <p>page</p>, { name: "s" }),
            ],
          ),
          path("/component", (ctx) => <Probe ctx={ctx} />, { name: "r" }),
          path(
            "/component-own-slot",
            (ctx) => <Probe ctx={ctx} />,
            { name: "os" },
            () => [
              parallel({
                // Resolves after the route handler returned, as a slot does.
                "@side": async () => {
                  await new Promise((resolve) => setTimeout(resolve, 0));
                  return <i>side</i>;
                },
              }),
            ],
          ),
        ],
      ),
      path("/inbox", () => <p>inbox</p>, { name: "inbox" }),
      path("/item/:id", () => <p>item</p>, { name: "item" }),
      intercept("@modal", ".item", (ctx) => <Probe ctx={ctx} />),
    ]),
  );
}

const URL_OF: Record<Exclude<Row, "intercept">, string> = {
  layout: "/component-layout",
  "parallel slot": "/component-slot",
  route: "/component",
  "route with its own slot": "/component-own-slot",
  loader: "/component-layout",
  "use cache": "/component-layout",
};

async function matchedOf(flight: string | undefined): Promise<string[]> {
  const { metadata } = await deserializeResult<{
    metadata: { matched: string[] };
  }>(flight!);
  return metadata.matched;
}

/** Serves the row, returning the matched segment ids and the reported errors. */
async function serve(row: Row, shape: CallShapeName) {
  errors.length = 0;
  const router = makeRouter(row, shape);
  const store = new MemorySegmentCacheStore();
  let matched: string[];
  if (row === "intercept") {
    const from = await serveShellRequest(router, "/inbox", {
      cacheStore: store,
    });
    const to = await serveShellRequest(router, "/item/1", {
      cacheStore: store,
      partial: {
        from: "/inbox",
        interceptSource: "/inbox",
        segments: await matchedOf(from.flight),
      },
    });
    matched = await matchedOf(to.flight);
  } else {
    const result = await serveShellRequest(router, URL_OF[row], {
      cacheStore: store,
    });
    matched = await matchedOf(result.flight);
  }
  return { errors: [...errors], matched };
}

/** The one LateHandlePushError the response reported, and its segment. */
function latePushSegment(reported: string[]): string {
  expect(reported).toHaveLength(1);
  const segment = /for segment "([^"]+)" was pushed after/.exec(reported[0]!);
  expect(segment).not.toBeNull();
  return segment![1]!;
}

/** The segment the row's push belongs to, read off the matched tree. */
function expectedSegment(row: Row, matched: string[]): string {
  switch (row) {
    case "parallel slot":
      return matched.find((id) => id.endsWith(".@panel"))!;
    case "intercept":
      return matched.find((id) => id.endsWith(".@modal"))!;
    case "route":
    case "route with its own slot":
      return matched.filter((id) => /R\d+$/.test(id)).at(-1)!;
    case "layout":
    case "loader":
    case "use cache":
      return matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
  }
}

beforeEach(async () => {
  await resetShellTestState();
});

describe("a LateHandlePushError names the segment whose ctx pushed", () => {
  for (const row of [
    "layout",
    "parallel slot",
    "route",
    "route with its own slot",
    "intercept",
    "loader",
  ] as const) {
    it(`${row}: in every call shape`, async () => {
      for (const shape of SHAPES) {
        const { errors: reported, matched } = await serve(row, shape);
        expect(`${shape}: ${latePushSegment(reported)}`, `row "${row}"`).toBe(
          `${shape}: ${expectedSegment(row, matched)}`,
        );
      }
    });
  }

  it('a "use cache" function given the layout\'s ctx pushes under the layout', async () => {
    const { errors: reported, matched } = await serve("use cache", "method");
    expect(latePushSegment(reported)).toBe(
      expectedSegment("use cache", matched),
    );
  });
});
