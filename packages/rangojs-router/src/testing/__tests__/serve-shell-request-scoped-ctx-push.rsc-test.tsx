/**
 * Which segment a handle push files under when the ctx that made it is a
 * scoped one: a layout's, a parallel slot's or an intercept's (withSegmentScope),
 * through serveShellRequest.
 *
 * The ctx carries its segment, so the attribution holds for every call shape a
 * component the handler handed it to can use: a method call, a detached
 * `const { use } = ctx`, a `{ ...ctx }` copy, and a call made while another
 * segment's runAsSegment scope is active (the object owns the ctx; the scope
 * only says whose code is running). The request's one handler ctx is the
 * route's: its pin goes back to the route after the walk, so a push a
 * component the route handler handed it to makes while a parallel slot has
 * resolved files under the route, not the slot.
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
import { runAsSegment } from "../../server/context.js";

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

type Push = "method" | "detached" | "spread" | "scope";

/** Pushes the ctx it was handed, in the call shape under test. */
function Push({
  ctx,
  label,
  how,
}: {
  ctx: HandlerContext;
  label: string;
  how: Push;
}) {
  if (how === "detached") {
    const { use } = ctx;
    use(Crumbs)(label);
  } else if (how === "spread") {
    const copy = { ...ctx } as HandlerContext;
    copy.use(Crumbs)(label);
  } else if (how === "scope") {
    // Another segment's runAsSegment scope: the ctx's own segment still owns
    // the push.
    runAsSegment("M0L0L0R9", () => ctx.use(Crumbs)(label));
  } else {
    ctx.use(Crumbs)(label);
  }
  return <span>{label}</span>;
}

const LayoutLoader = createLoader(async (ctx) => {
  ctx.use(Crumbs)("layout-loader");
  return null;
});

/** Starts a loader through the ctx it was handed, in the handler's tick. */
function LoaderPush({ ctx }: { ctx: HandlerContext }) {
  ctx.use(LayoutLoader);
  return <span>loader</span>;
}

function makeRouter() {
  return createRouter({}).routes(
    urls(({ path, layout, parallel }) => [
      layout(
        () => <main>shell</main>,
        () => [
          layout(
            (ctx) => <Push ctx={ctx} label="layout" how="method" />,
            () => [path("/layout", () => <p>page</p>, { name: "layout" })],
          ),
          layout(
            (ctx) => <Push ctx={ctx} label="detached" how="detached" />,
            () => [path("/detached", () => <p>page</p>, { name: "detached" })],
          ),
          layout(
            (ctx) => <Push ctx={ctx} label="spread" how="spread" />,
            () => [path("/spread", () => <p>page</p>, { name: "spread" })],
          ),
          layout(
            (ctx) => <Push ctx={ctx} label="scope" how="scope" />,
            () => [path("/scope", () => <p>page</p>, { name: "scope" })],
          ),
          layout(
            (ctx) => <LoaderPush ctx={ctx} />,
            () => [path("/loader", () => <p>page</p>, { name: "loader" })],
          ),
          layout(
            () => <section>slot frame</section>,
            () => [
              parallel({
                "@panel": (ctx) => <Push ctx={ctx} label="slot" how="method" />,
              }),
              path("/slot", () => <p>page</p>, { name: "slot" }),
            ],
          ),
          // The slot resolves after the route handler: the route's pin has
          // moved on by the time the component renders.
          path(
            "/route",
            (ctx) => <Push ctx={ctx} label="route" how="method" />,
            { name: "route" },
            () => [parallel({ "@side": () => <aside>side</aside> })],
          ),
        ],
      ),
    ]),
  );
}

/** The response's matched ids and the buckets the handle data landed in. */
async function serve(url: string) {
  const result = await serveShellRequest(makeRouter(), url, {
    cacheStore: new MemorySegmentCacheStore(),
  });
  const { hydration, late } = (await result.readHandles())!;
  const data = late.at(-1) ?? hydration;
  const { metadata } = await deserializeResult<{
    metadata: { matched: string[] };
  }>(result.flight!);
  return {
    matched: metadata.matched,
    buckets: (data[Crumbs.$$id] ?? {}) as Record<string, string[]>,
  };
}

beforeEach(async () => {
  await resetShellTestState();
});

describe("a scoped ctx's push files under the segment the ctx carries", () => {
  it("a layout's, for a component the layout handler handed its ctx to", async () => {
    const { matched, buckets } = await serve("/layout");
    const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    expect(buckets).toEqual({ [layout]: ["layout"] });
  });

  it("a layout's, for a detached `const { use } = ctx`", async () => {
    const { matched, buckets } = await serve("/detached");
    const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    expect(buckets).toEqual({ [layout]: ["detached"] });
  });

  it("a layout's, for a `{ ...ctx }` copy of the ctx", async () => {
    const { matched, buckets } = await serve("/spread");
    const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    expect(buckets).toEqual({ [layout]: ["spread"] });
  });

  it("a layout's, for a push made inside another segment's runAsSegment scope", async () => {
    const { matched, buckets } = await serve("/scope");
    const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    expect(buckets).toEqual({ [layout]: ["scope"] });
  });

  it("a layout's, for a loader the component starts through the ctx", async () => {
    const { matched, buckets } = await serve("/loader");
    const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    expect(buckets).toEqual({ [layout]: ["layout-loader"] });
  });

  it("a slot's, for a component the parallel slot's handler handed its ctx to", async () => {
    const { matched, buckets } = await serve("/slot");
    const slot = matched.find((id) => id.endsWith(".@panel"))!;
    expect(buckets).toEqual({ [slot]: ["slot"] });
  });

  it("the route's, for a component the route handler handed its ctx to, with a slot resolved after it", async () => {
    const { matched, buckets } = await serve("/route");
    const route = matched.filter((id) => /R\d+$/.test(id)).at(-1)!;
    expect(buckets).toEqual({ [route]: ["route"] });
  });
});
