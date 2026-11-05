/**
 * A "use cache" HIT replays a cached call's handle pushes into the segment of
 * the ctx that made the call, not into whichever segment the walker had
 * pinned when it did.
 *
 * The calling segment is `segmentPinOf(ctx)` (cache-runtime.ts
 * `callerSegmentId`): a layout's or slot's ctx answers with the segment it
 * carries (`_handleSegmentId`, withSegmentScope in router/handler-context.ts),
 * and only then with the walk's pin. A handler that is handed an outer
 * layout's ctx and calls a cached function with it has its own segment pinned
 * while it runs, so a replay read off the pin alone would file the crumb under
 * the handler's segment while the MISS — which pushes live through `ctx.use`,
 * and so through the carried segment — files it under the ctx's. The two must
 * agree.
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
import { createRouter, urls, type HandlerContext } from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import {
  CachedCrumbs,
  cachedCrumb,
  cachedCrumbRuns,
} from "./fixtures/streamed-handle-owner-data.js";

const held: { ctx?: HandlerContext } = {};

/**
 * The outer layout hands its ctx on; the inner layout's handler calls a cached
 * function with it after an await. The walker pins the inner layout while that
 * handler runs, the ctx carries the outer layout.
 */
function makeRouter() {
  return createRouter({}).routes(
    urls(({ path, layout }) => [
      layout(
        (outer) => {
          held.ctx = outer;
          return <main>shell</main>;
        },
        () => [
          layout(
            async () => {
              await new Promise((resolve) => setTimeout(resolve, 0));
              await cachedCrumb(held.ctx!, "layout");
              return <section>inner</section>;
            },
            () => [path("/c", () => <p>page</p>, { name: "c" })],
          ),
        ],
      ),
    ]),
  );
}

async function serve(
  router: Parameters<typeof serveShellRequest>[0],
  cacheStore: MemorySegmentCacheStore,
) {
  const result = await serveShellRequest(router, "/c", { cacheStore });
  const { hydration, late } = (await result.readHandles())!;
  const data = late.at(-1) ?? hydration;
  const { metadata } = await deserializeResult<{
    metadata: { matched: string[] };
  }>(result.flight!);
  return {
    buckets: (data[CachedCrumbs.$$id] ?? {}) as Record<string, string[]>,
    matched: metadata.matched,
  };
}

beforeEach(async () => {
  await resetShellTestState();
});

describe("a cached call through a layout's ctx", () => {
  it("files its MISS and its HIT pushes under that layout, not the walker's pin", async () => {
    const router = makeRouter();
    const cacheStore = new MemorySegmentCacheStore();
    const runs = cachedCrumbRuns.count;

    const miss = await serve(router, cacheStore);
    // The root layout, the ctx's owner, the layout whose handler made the call.
    const layouts = miss.matched.filter((id) => /L\d+$/.test(id));
    const owner = layouts[1]!;
    expect(layouts.at(-1)).not.toBe(owner);

    const hit = await serve(router, cacheStore);

    expect(cachedCrumbRuns.count - runs).toBe(1);
    expect(miss.buckets).toEqual({ [owner]: ["layout"] });
    expect(hit.buckets).toEqual({ [owner]: ["layout"] });
  });
});
