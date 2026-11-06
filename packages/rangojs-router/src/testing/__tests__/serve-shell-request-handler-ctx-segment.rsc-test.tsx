/**
 * Which segment a call through a handler's ctx attributes to, in every call
 * shape: the handler matrix of review-correctness step 6, through
 * serveShellRequest and the `callShapes` probe.
 *
 * The expected answer is set by ownership, not by what the code does: whatever
 * a call does through a handler's ctx belongs to that handler's segment,
 * wherever the call runs (a component it handed the ctx to, a loader it
 * starts) and whenever (after an await, after the handler returned). A push
 * that beats handle collection lands in that segment's bucket; one that misses
 * it throws LateHandlePushError naming that segment.
 *
 * The route row is why the shared ctx stamps `_routeSegmentId`
 * (resolveRouteComponent): the walker resolves a route's own parallel slots
 * after the handler and leaves the shared pin on the last one.
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

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

/** The loader row's loader: a handler-started loader that pushes a crumb. */
const CtxLoader = createLoader(async (ctx) => {
  ctx.use(Crumbs)("loader");
  return { ok: true };
});

const errors: string[] = [];

type Mode = "handle" | "loader";

/** Runs one call shape of `ctx.use` and pushes (or starts the loader) through it. */
async function Probe({
  ctx,
  shape,
  label,
  mode,
}: {
  ctx: HandlerContext;
  shape: CallShapeName;
  label: string;
  mode: Mode;
}) {
  const shapes = callShapes(ctx as object, "use" as never);
  const shapeDef = shapes.find((s) => s.name === shape)!;
  if (mode === "loader") {
    await shapeDef.call(CtxLoader);
    return <span>{label}</span>;
  }
  const push = (await shapeDef.call(Crumbs)) as (value: unknown) => void;
  push(`${label}:${shape}`);
  return <span>{label}</span>;
}

type Row =
  | "layout"
  | "parallel slot"
  | "route"
  | "route with its own slot"
  | "intercept"
  | "loader";

const SHAPES: CallShapeName[] = [
  "method",
  "detached",
  "spread",
  "spread detached",
  "after await",
  "after await detached",
];

function makeRouter(row: Row, shape: CallShapeName) {
  const probe = (ctx: HandlerContext, label: string, mode: Mode) => (
    <Probe ctx={ctx} shape={shape} label={label} mode={mode} />
  );
  return createRouter({
    onError: ({ error }) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
  }).routes(
    urls(({ path, layout, parallel, intercept }) => [
      layout(
        () => <main>shell</main>,
        () => [
          path("/list", () => <ul>list</ul>, { name: "list" }),
          path("/item/:id", () => <article>item</article>, { name: "item" }),
          ...(row === "layout" || row === "loader"
            ? [
                layout(
                  (ctx) =>
                    probe(
                      ctx,
                      row === "loader" ? "loader" : "layout",
                      row === "loader" ? "loader" : "handle",
                    ),
                  () => [path("/x", () => <p>page</p>, { name: "x" })],
                ),
              ]
            : []),
          ...(row === "parallel slot"
            ? [
                layout(
                  () => <section>frame</section>,
                  () => [
                    parallel({
                      "@side": (ctx: HandlerContext) =>
                        probe(ctx, "side", "handle"),
                    }),
                    path("/x", () => <p>page</p>, { name: "x" }),
                  ],
                ),
              ]
            : []),
          ...(row === "route"
            ? [
                path("/x", (ctx) => probe(ctx, "route", "handle"), {
                  name: "x",
                }),
              ]
            : []),
          ...(row === "route with its own slot"
            ? [
                path(
                  "/x",
                  (ctx) => probe(ctx, "route slot", "handle"),
                  { name: "x" },
                  () => [parallel({ "@side": () => <aside>side</aside> })],
                ),
              ]
            : []),
          ...(row === "intercept"
            ? [
                intercept("@modal", ".item", (ctx: HandlerContext) =>
                  probe(ctx, "modal", "handle"),
                ),
              ]
            : []),
        ],
      ),
    ]),
  );
}

async function matchedOf(flight: string | undefined): Promise<string[]> {
  const { metadata } = await deserializeResult<{
    metadata: { matched: string[] };
  }>(flight!);
  return metadata.matched;
}

/** The segment the one push (or the error it threw) named, or undefined. */
async function segmentNamedBy(
  row: Row,
  shape: CallShapeName,
  label: string,
): Promise<{ matched: string[]; segment: string | undefined }> {
  errors.length = 0;
  const router = makeRouter(row, shape);
  const cacheStore = new MemorySegmentCacheStore();
  let flight: string | undefined;
  if (row === "intercept") {
    const list = await serveShellRequest(router, "/list", {
      cacheStore,
      partial: true,
    });
    const from = await matchedOf(list.flight);
    const result = await serveShellRequest(router, "/item/1", {
      cacheStore,
      partial: { from: "/list", segments: from },
    });
    flight = result.flight;
    const handles = await result.readHandles();
    const buckets = ((handles?.hydration ?? {})[Crumbs.$$id] ?? {}) as Record<
      string,
      string[]
    >;
    return { matched: await matchedOf(flight), segment: named(buckets) };
  }
  const result = await serveShellRequest(router, "/x", { cacheStore });
  flight = result.flight;
  const handles = await result.readHandles();
  const buckets = ((handles?.hydration ?? {})[Crumbs.$$id] ?? {}) as Record<
    string,
    string[]
  >;
  return { matched: await matchedOf(flight), segment: named(buckets) };

  function named(buckets: Record<string, string[]>): string | undefined {
    const bucket = Object.keys(buckets).find((id) =>
      buckets[id]!.some(
        (value) => value === label || value.startsWith(`${label}:`),
      ),
    );
    if (bucket) return bucket;
    const message = errors[0];
    if (!message) return undefined;
    return /for segment "([^"]+)" was pushed after/.exec(message)?.[1];
  }
}

/** The segment each row's ctx belongs to, read off the tree it matched. */
function expectedOf(row: Row, matched: string[]): string {
  switch (row) {
    case "layout":
    case "loader":
      return matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    case "parallel slot":
      return matched.find((id) => id.endsWith(".@side"))!;
    case "route":
    case "route with its own slot":
      return matched.filter((id) => /R\d+$/.test(id)).at(-1)!;
    case "intercept":
      return matched.find((id) => id.endsWith(".@modal"))!;
  }
}

beforeEach(async () => {
  await resetShellTestState();
});

describe("a call through a handler's ctx attributes to that handler's segment", () => {
  for (const row of [
    "layout",
    "parallel slot",
    "route",
    "route with its own slot",
    "intercept",
    "loader",
  ] as Row[]) {
    it(`${row}: every call shape`, async () => {
      const answers: Record<string, string> = {};
      for (const shape of SHAPES) {
        const { matched, segment } = await segmentNamedBy(
          row,
          shape,
          row === "loader" ? "loader" : "probe",
        );
        expect(
          segment,
          `${row} / ${shape}: named segment, matched ${matched.join(",")}`,
        ).toBe(expectedOf(row, matched));
        answers[shape] = segment!;
      }
      // Every shape named the same segment.
      expect(new Set(Object.values(answers)).size).toBe(1);
    });
  }
});
