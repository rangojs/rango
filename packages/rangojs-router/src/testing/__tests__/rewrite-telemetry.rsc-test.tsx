/**
 * Telemetry of a `throw rewrite()` request through the production request
 * handler (serveShellRequest): every event carries the visitor's request id,
 * the one dispatch() reports for the same request.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import React, { Suspense } from "react";

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
  createRouter,
  rewrite,
  urls,
  type TelemetryEvent,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";

const events: TelemetryEvent[] = [];

async function SlowReviews(): Promise<React.ReactNode> {
  await new Promise((resolve) => setTimeout(resolve, 100));
  return <p>reviews</p>;
}

const router = createRouter({
  telemetry: { emit: (event) => events.push(event) },
  timeouts: { streamIdleMs: 20 },
})
  .use(async (ctx, next) => {
    if (ctx.pathname === "/old-shop") throw rewrite("/shop");
    if (ctx.pathname === "/old-product") throw rewrite("/product");
    return next();
  })
  .routes(
    urls(({ path }) => [
      path("/shop", () => <p>shop page</p>, { name: "shop" }),
      path(
        "/product",
        () => (
          <main>
            <Suspense fallback={<p>loading reviews</p>}>
              <SlowReviews />
            </Suspense>
          </main>
        ),
        { name: "product" },
      ),
    ]),
  );

function eventIds(): Array<[TelemetryEvent["type"], string | undefined]> {
  return events.map((event) => [event.type, event.requestId]);
}

beforeEach(() => {
  resetShellTestState();
  events.length = 0;
});

describe("telemetry of a rewritten request", () => {
  it("a stream-idle request.timeout carries the requestId of request.start and request.end", async () => {
    await expect(
      serveShellRequest(router, "/old-product", {
        cacheStore: new MemorySegmentCacheStore(),
      }),
    ).rejects.toMatchObject({ name: "RouterTimeoutError" });

    const types = events.map((event) => event.type);
    expect(types).toContain("request.start");
    expect(types).toContain("request.end");
    expect(types.at(-1)).toBe("request.timeout");
    const start = events.find((event) => event.type === "request.start")!;
    expect(start.requestId).toMatch(/^t-/);
    for (const [type, requestId] of eventIds()) {
      expect([type, requestId]).toEqual([type, start.requestId]);
    }
  });

  it("a request-id header stays the requestId of every event", async () => {
    await expect(
      serveShellRequest(router, "/old-product", {
        cacheStore: new MemorySegmentCacheStore(),
        headers: { "x-request-id": "visitor-7" },
      }),
    ).rejects.toMatchObject({ name: "RouterTimeoutError" });

    expect(events.map((event) => event.type)).toContain("request.timeout");
    for (const [type, requestId] of eventIds()) {
      expect([type, requestId]).toEqual([type, "visitor-7"]);
    }
  });

  it("a rewrite that ends in time reports one requestId", async () => {
    const result = await serveShellRequest(router, "/old-shop", {
      cacheStore: new MemorySegmentCacheStore(),
    });
    expect(result.response.headers.get("x-rango-rewrite")).toBe("/shop");
    expect(events.map((event) => event.type)).toEqual([
      "request.start",
      "cache.decision",
      "request.end",
    ]);
    const [start] = events;
    for (const [type, requestId] of eventIds()) {
      expect([type, requestId]).toEqual([type, start!.requestId]);
    }
  });
});
