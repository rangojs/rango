/**
 * intercept()'s `when` selector, through a public primitive: a client
 * navigation (`serveShellRequest` with `partial: { from }`) runs the
 * production match, and the selector sees `from` / `to` as
 * { url, params, routeName } (no `state`: history state never reaches the
 * server).
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
import { createRouter, urls } from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import type { InterceptSelectorContext } from "../../server/context.js";

function makeRouter(when: (ctx: InterceptSelectorContext) => boolean) {
  return createRouter({}).routes(
    urls(({ path, layout, intercept }) => [
      layout(
        () => <main>shell</main>,
        () => [
          path("/list/:section", () => <ul>list</ul>, { name: "list" }),
          path("/item/:id", () => <article>item</article>, { name: "item" }),
          intercept("@modal", ".item", () => <dialog>modal</dialog>, {
            when,
          }),
        ],
      ),
    ]),
  );
}

function interceptSegmentIds(flight: string | undefined): string[] {
  const row = flight?.split("\n").find((line) => line.startsWith("0:"));
  expect(row).toBeDefined();
  const { segments } = JSON.parse(row!.slice(2)).metadata as {
    segments: Array<{ id: string; namespace?: string }>;
  };
  return segments
    .filter((segment) => segment.namespace?.startsWith("intercept:"))
    .map((segment) => segment.id);
}

beforeEach(() => resetShellTestState());

describe("intercept({ when }) selector context", () => {
  it("sees from/to as { url, params, routeName } and selects on them", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const when = vi.fn((ctx: InterceptSelectorContext) => {
      seen.push({
        from: `${ctx.from.url.pathname} ${ctx.from.routeName} ${JSON.stringify(ctx.from.params)}`,
        to: `${ctx.to.url.pathname} ${ctx.to.routeName} ${JSON.stringify(ctx.to.params)}`,
        keys: Object.keys(ctx).sort(),
      });
      return ctx.from.params.section === "open" && ctx.to.params.id !== "skip";
    });
    const router = makeRouter(when);
    const serve = (url: string, from: string) =>
      serveShellRequest(router, url, {
        cacheStore: new MemorySegmentCacheStore(),
        partial: { from },
      });

    const opened = await serve("/item/1", "/list/open");
    expect(interceptSegmentIds(opened.flight).length).toBeGreaterThan(0);
    expect(seen[0]).toEqual({
      from: '/list/open list {"section":"open"}',
      to: '/item/1 item {"id":"1"}',
      keys: ["env", "from", "request", "segments", "to"],
    });

    const closed = await serve("/item/1", "/list/closed");
    expect(interceptSegmentIds(closed.flight)).toEqual([]);

    const skipped = await serve("/item/skip", "/list/open");
    expect(interceptSegmentIds(skipped.flight)).toEqual([]);
    expect(when).toHaveBeenCalledTimes(3);
  });

  it("a throwing selector renders the full page (no intercept) and logs the route name", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const router = makeRouter(() => {
      throw new Error("selector boom");
    });
    const result = await serveShellRequest(router, "/item/1", {
      cacheStore: new MemorySegmentCacheStore(),
      partial: { from: "/list/open" },
    });
    expect(interceptSegmentIds(result.flight)).toEqual([]);
    expect(result.flight).toContain("item");
    expect(
      error.mock.calls.some((call) =>
        String(call[0]).includes('intercept({ when }) for route "item"'),
      ),
    ).toBe(true);
    error.mockRestore();
  });
});
