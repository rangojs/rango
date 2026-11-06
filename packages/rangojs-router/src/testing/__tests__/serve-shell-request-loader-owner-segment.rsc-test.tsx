/**
 * The segment a loader's handle pushes belong to when a layout's component
 * starts it through the ctx its handler handed the layout, served with
 * serveShellRequest.
 *
 * `loaderOwner` reads the segment off the ctx (segmentPinOf: a layout's or a
 * slot's carried `_handleSegmentId`, else the walker's pin). A component
 * renders after the handler returned, so the pin it would read is the child
 * route's; the crumb belongs to the layout that declared the component.
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
  type ServeShellRequestResult,
} from "../flight.entry.js";
import {
  createHandle,
  createLoader,
  createRouter,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import type { HandleData } from "../../server/handle-store.js";

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

/** Started from the layout's component, not from its handler. */
const LayoutData = createLoader(async (ctx) => {
  ctx.use(Crumbs)("layout-loader");
  return { value: 1 };
});

function LayoutBody({ ctx }: { ctx: HandlerContext }) {
  ctx.use(LayoutData);
  return <div>layout</div>;
}

function makeRouter() {
  return createRouter({}).routes(
    urls(({ path, layout, parallel }) => [
      layout(
        () => <main>shell</main>,
        () => [
          layout(
            (ctx) => <LayoutBody ctx={ctx} />,
            () => [path("/loader", () => <p>page</p>, { name: "loader" })],
          ),
          layout(
            () => <section>slot frame</section>,
            () => [
              parallel({
                "@panel": (ctx) => <LayoutBody ctx={ctx} />,
              }),
              path("/loader-slot", () => <p>page</p>, { name: "loaderSlot" }),
            ],
          ),
        ],
      ),
    ]),
  );
}

/** Each segment's Crumbs values the response delivers. */
async function crumbsBySegment(
  result: ServeShellRequestResult,
): Promise<Record<string, unknown[]>> {
  const handles = await result.readHandles();
  const data = (handles?.late.at(-1) ?? handles?.hydration ?? {}) as HandleData;
  return (data[Crumbs.$$id] ?? {}) as Record<string, unknown[]>;
}

async function matchedOf(flight: string | undefined): Promise<string[]> {
  const { metadata } = await deserializeResult<{
    metadata: { matched: string[] };
  }>(flight!);
  return metadata.matched;
}

async function serve(url: string) {
  const result = await serveShellRequest(makeRouter(), url, {
    cacheStore: new MemorySegmentCacheStore(),
  });
  return {
    crumbs: await crumbsBySegment(result),
    matched: await matchedOf(result.flight),
  };
}

beforeEach(async () => {
  await resetShellTestState();
});

describe("a loader a component starts files its pushes under the ctx's segment", () => {
  it("the layout's, for a loader the layout's component started", async () => {
    const { crumbs, matched } = await serve("/loader");
    const layout = matched.filter((id) => /L\d+$/.test(id)).at(-1)!;
    const route = matched.filter((id) => /R\d+$/.test(id)).at(-1)!;
    expect(crumbs[layout]).toEqual(["layout-loader"]);
    expect(crumbs[route]).toBeUndefined();
  });

  it("the slot's, for a loader a parallel slot's component started", async () => {
    const { crumbs, matched } = await serve("/loader-slot");
    const slot = matched.find((id) => id.endsWith(".@panel"))!;
    const route = matched.filter((id) => /R\d+$/.test(id)).at(-1)!;
    expect(crumbs[slot]).toEqual(["layout-loader"]);
    expect(crumbs[route]).toBeUndefined();
  });
});
