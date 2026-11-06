/**
 * The segment a handle push through a handler's ctx files under — and the
 * segment a dev LateHandlePushError names — for a component the handler
 * handed its ctx to, in every way a consumer calls `ctx.use`.
 *
 * A push after the `await` is rejected by design (the `.defer()` path is the
 * mitigation), so the message is all a consumer sees of it: it must name the
 * segment whose ctx made the push, not whichever segment the walker pinned
 * since. The receiver cannot decide that: a detached `const { use } = ctx`
 * has no receiver, and a `{ ...ctx }` copy of a prototype child inherits no
 * method, so the segment is part of the call (SegmentAwareUse,
 * types/handler-context.ts) and the shapes below are one table.
 *
 * The route's own ctx is the request's one ctx, whose segment is the pin; a
 * slot's handler pins it only while it runs, so a push through the route's
 * ctx after that slot ran is still the route's.
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

/** One way a consumer calls `ctx.use`. */
type Shape =
  | "method"
  | "detached"
  | "spread"
  | "spread detached"
  | "after await"
  | "after await detached";

const SHAPES: readonly Shape[] = [
  "method",
  "detached",
  "spread",
  "spread detached",
  "after await",
  "after await detached",
];

function useOf(holder: object): (item: unknown) => (value: unknown) => void {
  const use = (holder as { use?: unknown }).use;
  if (typeof use !== "function") {
    throw new TypeError("ctx.use is not a function on this object");
  }
  return use as (item: unknown) => (value: unknown) => void;
}

/** `ctx.use(Crumbs)(label)` in `shape`. */
async function pushInShape(
  shape: Shape,
  ctx: HandlerContext,
  label: string,
): Promise<void> {
  const push = (holder: object, receiver: object | undefined) => {
    const use = useOf(holder);
    const bound =
      receiver === undefined ? use(Crumbs) : use.call(receiver, Crumbs);
    bound(label);
  };
  switch (shape) {
    case "method":
      return push(ctx, ctx);
    case "detached":
      return push(ctx, undefined);
    case "spread": {
      const copy = { ...(ctx as object) };
      return push(copy, copy);
    }
    case "spread detached":
      return push({ ...(ctx as object) }, undefined);
    case "after await": {
      await Promise.resolve();
      return push(ctx, ctx);
    }
    case "after await detached":
      await Promise.resolve();
      return push(ctx, undefined);
  }
}

/** An async server component pushing the ctx its handler handed it. */
async function LatePush({
  ctx,
  label,
  shape,
}: {
  ctx: HandlerContext;
  label: string;
  shape: Shape;
}) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    // Awaited: the rejected push is this component's, not an unhandled
    // rejection the test file would fail on.
    await pushInShape(shape, ctx, label);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return <span>{label}</span>;
}

/**
 * A cached DSL loader on the layout. Its resolution installs loader-cache's
 * read-through interceptor on the request ctx, so every push and loader read
 * below reaches setupLoaderAccess through that wrapper (which forwards the
 * segment argument).
 */
const CachedLoader = createLoader(async () => "cached");

/** A loader a component starts through the ctx it was handed. */
const SlowLoader = createLoader(async (ctx) => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  ctx.use(Crumbs)("from-loader");
  return "slow";
});

async function LateLoader({ ctx }: { ctx: HandlerContext }) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await ctx.use(SlowLoader);
  return <span>loaded</span>;
}

type Row = "layout" | "slot" | "route" | "route with its own slot" | "loader";

function makeRouter(row: Row | "intercept", shape: Shape) {
  const late = (ctx: HandlerContext, label: string) => (
    <LatePush ctx={ctx} label={label} shape={shape} />
  );
  return createRouter({
    onError: ({ error }) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
  }).routes(
    urls(({ path, layout, parallel, intercept, loader, cache }) => [
      path("/index", () => <p>index</p>, { name: "index" }),
      layout(
        () => <main>shell</main>,
        () => [
          loader(CachedLoader, () => [cache({ ttl: 60 })]),
          layout(
            (ctx) => (
              <div>
                {row === "loader" ? <LateLoader ctx={ctx} /> : null}
                {row === "layout" ? late(ctx, "layout") : null}
              </div>
            ),
            () => [
              path("/component-layout", () => <p>page</p>, {
                name: "componentLayout",
              }),
              path("/loader-from-layout", () => <p>page</p>, {
                name: "loaderFromLayout",
              }),
            ],
          ),
          layout(
            () => <section>slot frame</section>,
            () => [
              parallel({
                "@panel": (ctx) => (
                  <i>{row === "slot" ? late(ctx, "slot") : "panel"}</i>
                ),
              }),
              path("/component-slot", () => <p>page</p>, {
                name: "componentSlot",
              }),
            ],
          ),
          path(
            "/component",
            (ctx) => <p>{row === "route" ? late(ctx, "route") : "page"}</p>,
            { name: "component" },
          ),
          path(
            "/route-with-slot",
            (ctx) => (
              <p>
                {row === "route with its own slot"
                  ? late(ctx, "route with its own slot")
                  : "page"}
              </p>
            ),
            { name: "routeWithSlot" },
            () => [parallel({ "@own": () => <i>own slot</i> })],
          ),
          path("/intercept-target", () => <p>target</p>, {
            name: "interceptTarget",
          }),
          intercept("@modal", ".interceptTarget", (ctx) =>
            row === "intercept" ? late(ctx, "intercept") : <div>modal</div>,
          ),
        ],
      ),
    ]),
  );
}

const ROUTES: Record<Row | "intercept", string> = {
  layout: "/component-layout",
  slot: "/component-slot",
  route: "/component",
  "route with its own slot": "/route-with-slot",
  intercept: "/intercept-target",
  loader: "/loader-from-layout",
};

async function matchedOf(flight: string | undefined): Promise<string[]> {
  const { metadata } = await deserializeResult<{
    metadata: { matched: string[] };
  }>(flight!);
  return metadata.matched;
}

type Lane = "document" | "navigation";

/**
 * Serve `row`'s page from an empty store: as the document, or as a navigation
 * from /index that holds nothing. The intercept row opens the intercept from
 * /index either way (a document request renders no intercept).
 */
async function serve(
  row: Row | "intercept",
  lane: Lane,
  shape: Shape = "method",
) {
  errors.length = 0;
  const store = new MemorySegmentCacheStore();
  const router = makeRouter(row, shape);
  let partial: { from: string; segments: string[] } | undefined;
  if (lane === "navigation" || row === "intercept") {
    const index = await serveShellRequest(router, "/index", {
      cacheStore: store,
      partial: true,
    });
    partial = { from: "/index", segments: await matchedOf(index.flight) };
    errors.length = 0;
  }
  const result = await serveShellRequest(router, ROUTES[row], {
    cacheStore: store,
    ...(partial ? { partial } : {}),
  });
  return { errors: [...errors], matched: await matchedOf(result.flight) };
}

/** The segment the LateHandlePushError reported, or its absence. */
function latePushSegment(reported: string[]): string {
  const segments = reported
    .map((message) => /for segment "([^"]+)" was pushed after/.exec(message))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match[1]!);
  return segments[0] ?? `no LateHandlePushError (${reported.join(" | ")})`;
}

/** The segment a row's push belongs to, out of the matched chain. */
function ownerOf(row: Row | "intercept", matched: string[]): string {
  switch (row) {
    case "layout":
    case "loader":
      return matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    case "slot":
      return matched.find((id) => id.endsWith(".@panel"))!;
    case "intercept":
      return matched.find((id) => id.endsWith(".@modal"))!;
    default:
      return matched.filter((id) => /R\d+$/.test(id)).at(-1)!;
  }
}

beforeEach(async () => {
  await resetShellTestState();
});

for (const lane of ["document", "navigation"] as const) {
  describe(`a late push names the segment whose ctx pushed (${lane})`, () => {
    for (const row of [
      "layout",
      "slot",
      "route",
      "route with its own slot",
    ] as const) {
      it(`${row}: every call shape`, async () => {
        const wrong: string[] = [];
        for (const shape of SHAPES) {
          const { errors: reported, matched } = await serve(row, lane, shape);
          const owner = ownerOf(row, matched);
          const named = latePushSegment(reported);
          if (named !== owner)
            wrong.push(`${shape}: ${named} (owner ${owner})`);
        }
        expect(wrong).toEqual([]);
      });
    }

    it("loader a component started through the layout's ctx", async () => {
      const { errors: reported, matched } = await serve("loader", lane);
      expect(latePushSegment(reported)).toBe(ownerOf("loader", matched));
    });
  });
}

describe("an intercept handler's ctx carries its slot's segment (navigation)", () => {
  it("every call shape", async () => {
    const wrong: string[] = [];
    for (const shape of SHAPES) {
      const { errors: reported, matched } = await serve(
        "intercept",
        "navigation",
        shape,
      );
      const owner = ownerOf("intercept", matched);
      const named = latePushSegment(reported);
      if (named !== owner) wrong.push(`${shape}: ${named} (owner ${owner})`);
    }
    expect(wrong).toEqual([]);
  });
});
