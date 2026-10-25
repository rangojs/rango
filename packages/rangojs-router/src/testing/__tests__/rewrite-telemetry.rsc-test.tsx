/**
 * Telemetry of a `throw rewrite()` request and of a no-JS form post through
 * the production request handler (serveShellRequest): every event carries the
 * visitor's request id, the one dispatch() reports for the same request.
 */
import { AsyncResource } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { Suspense } from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import {
  createActionForm,
  resetShellTestState,
  serveShellRequest,
  type ServeShellRequestOptions,
} from "../flight.entry.js";
import {
  createLoader,
  createRouter,
  rewrite,
  urls,
  type TelemetryEvent,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";

/**
 * Only the stream-idle watchdog arms a timer this long. The setTimeout spy
 * holds it and serveUntilIdleTrip trips it, so a stream ends by the trip only
 * when a case trips it, however busy the worker is.
 */
const STREAM_IDLE_MS = 123_456_789;

const nativeSetTimeout = globalThis.setTimeout;

const events: TelemetryEvent[] = [];

/** The watchdog's last armed callback, held instead of scheduled. */
let tripIdle: (() => void) | undefined;
let markShellStreaming!: () => void;
let shellStreaming: Promise<void>;
let markReviewsRendering!: () => void;
let reviewsRendering: Promise<void>;

/** Never settles: the stream stays open until the watchdog trips. */
function PendingReviews(): Promise<React.ReactNode> {
  markReviewsRendering();
  return new Promise(() => {});
}

async function save(_prev: unknown, _form: FormData): Promise<string> {
  return "saved";
}

const ItemLoader = createLoader(async () => ({ item: 1 }));

const router = createRouter({
  telemetry: { emit: (event) => events.push(event) },
  timeouts: { streamIdleMs: STREAM_IDLE_MS },
})
  .use(async (ctx, next) => {
    if (ctx.pathname === "/hop1") throw rewrite("/hop2");
    if (ctx.pathname === "/old-shop") throw rewrite("/shop");
    if (ctx.pathname === "/old-product") throw rewrite("/product");
    return next();
  })
  .routes(
    urls(({ path, middleware, loader }) => [
      path("/shop", () => <p>shop page</p>, { name: "shop" }),
      path(
        "/hop2",
        () => <p>hop2</p>,
        { name: "hop2" },
        () => [
          middleware(() => {
            throw rewrite("/hop3");
          }),
        ],
      ),
      path(
        "/hop3",
        () => <p>hop3</p>,
        { name: "hop3" },
        () => [
          middleware(() => {
            throw rewrite("/product");
          }),
        ],
      ),
      path(
        "/product",
        () => (
          <main>
            <Suspense fallback={<p>loading reviews</p>}>
              <PendingReviews />
            </Suspense>
          </main>
        ),
        { name: "product" },
        () => [loader(ItemLoader)],
      ),
    ]),
  );

function eventIds(): Array<[TelemetryEvent["type"], string | undefined]> {
  return events.map((event) => [event.type, event.requestId]);
}

/**
 * Serve `url` and trip the watchdog once the stream is held open: a chunk of
 * the shell reached the client and the render waits on the pending reviews.
 */
async function serveUntilIdleTrip(
  url: string,
  options: ServeShellRequestOptions,
) {
  const served = serveShellRequest(router, url, options);
  await Promise.race([served, Promise.all([reviewsRendering, shellStreaming])]);
  tripIdle?.();
  return served;
}

beforeEach(async () => {
  await resetShellTestState();
  events.length = 0;
  tripIdle = undefined;
  shellStreaming = new Promise((resolve) => (markShellStreaming = resolve));
  reviewsRendering = new Promise((resolve) => (markReviewsRendering = resolve));
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    if (ms !== STREAM_IDLE_MS) return nativeSetTimeout(callback, ms, ...args);
    // The watchdog arms at the response handoff and re-arms on every chunk.
    if (tripIdle) markShellStreaming();
    // Bound to the context it was armed in, as a Node timer's callback is. The
    // handle is the callback: clearTimeout ignores it, and a trip after the
    // watchdog disarmed does nothing.
    return (tripIdle = AsyncResource.bind(callback));
  }) as typeof setTimeout);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("telemetry of a rewritten request", () => {
  it("a stream-idle request.timeout carries the requestId of request.start and request.end", async () => {
    await expect(
      serveUntilIdleTrip("/old-product", {
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

  it("a chain of rewrites (global, then two route middleware) reports one requestId", async () => {
    await expect(
      serveUntilIdleTrip("/hop1", {
        cacheStore: new MemorySegmentCacheStore(),
      }),
    ).rejects.toMatchObject({ name: "RouterTimeoutError" });

    expect(events.map((event) => event.type).at(-1)).toBe("request.timeout");
    const start = events.find((event) => event.type === "request.start")!;
    expect(start.requestId).toMatch(/^t-/);
    for (const [type, requestId] of eventIds()) {
      expect([type, requestId]).toEqual([type, start.requestId]);
    }
  });

  it("a request-id header stays the requestId of every event", async () => {
    await expect(
      serveUntilIdleTrip("/old-product", {
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

describe("telemetry of a no-JS form post", () => {
  it("the re-render's events and a stream-idle request.timeout carry one requestId", async () => {
    await expect(
      serveUntilIdleTrip("/product", {
        cacheStore: new MemorySegmentCacheStore(),
        form: createActionForm(save, { id: "actions.ts#save" }),
      }),
    ).rejects.toMatchObject({ name: "RouterTimeoutError" });

    const types = events.map((event) => event.type);
    expect(types).toContain("request.start");
    expect(types).toContain("loader.end");
    expect(types).toContain("request.end");
    expect(types.at(-1)).toBe("request.timeout");
    const start = events.find((event) => event.type === "request.start")!;
    expect(start.requestId).toMatch(/^t-/);
    for (const [type, requestId] of eventIds()) {
      expect([type, requestId]).toEqual([type, start.requestId]);
    }
  });

  it("a rewritten form post reports one requestId", async () => {
    await expect(
      serveUntilIdleTrip("/old-product", {
        cacheStore: new MemorySegmentCacheStore(),
        form: createActionForm(save, { id: "actions.ts#saveRewritten" }),
      }),
    ).rejects.toMatchObject({ name: "RouterTimeoutError" });

    expect(events.map((event) => event.type).at(-1)).toBe("request.timeout");
    const start = events.find((event) => event.type === "request.start")!;
    expect(start.requestId).toMatch(/^t-/);
    for (const [type, requestId] of eventIds()) {
      expect([type, requestId]).toEqual([type, start.requestId]);
    }
  });

  it("a request-id header stays the requestId of every event", async () => {
    await expect(
      serveUntilIdleTrip("/old-product", {
        cacheStore: new MemorySegmentCacheStore(),
        headers: { "x-request-id": "visitor-9" },
        form: createActionForm(save, { id: "actions.ts#saveWithHeader" }),
      }),
    ).rejects.toMatchObject({ name: "RouterTimeoutError" });

    expect(events.map((event) => event.type)).toContain("request.timeout");
    for (const [type, requestId] of eventIds()) {
      expect([type, requestId]).toEqual([type, "visitor-9"]);
    }
  });
});
