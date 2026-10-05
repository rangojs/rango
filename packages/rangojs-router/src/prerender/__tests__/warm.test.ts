/**
 * The warm runner (prerender/warm.ts): the synthetic request, the collecting
 * execution context, the wait for background work, and the status a record
 * derives. The handler is a fake `fetch`, so the request it receives and what
 * it does with the record are under the test's control.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createCollectingExecutionContext,
  runWarmRequest,
  warmCaches,
  warmStatus,
  type WarmRequestOutcome,
} from "../warm.js";
import {
  createWarmRecord,
  readWarmMark,
  type PrerenderWarmRecord,
} from "../warm-request.js";
import { MemorySegmentCacheStore } from "../../cache/memory-segment-store.js";

const cacheConfig = { store: new MemorySegmentCacheStore() };

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("createCollectingExecutionContext", () => {
  it("keeps every promise handed to waitUntil", async () => {
    const ctx = createCollectingExecutionContext();
    const a = Promise.resolve(1);
    ctx.waitUntil(a);
    ctx.waitUntil(Promise.resolve(2));

    expect(ctx.tasks).toHaveLength(2);
    await expect(Promise.all(ctx.tasks)).resolves.toBeDefined();
  });

  it("forwards to the caller's context, so the platform keeps the work alive too", () => {
    const inner = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };
    const ctx = createCollectingExecutionContext(inner);
    ctx.waitUntil(Promise.resolve());

    expect(inner.waitUntil).toHaveBeenCalledTimes(1);
    expect(ctx.tasks).toHaveLength(1);
  });

  it("a rejected task neither rejects the list nor goes unhandled without a host", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = createCollectingExecutionContext();
    ctx.waitUntil(Promise.reject(new Error("boom")));

    await expect(Promise.all(ctx.tasks)).resolves.toEqual([undefined]);
    expect(error).toHaveBeenCalledWith(
      "[waitUntil] Background task failed:",
      expect.any(Error),
    );
    error.mockRestore();
  });

  it("reads every other member through to the caller's context, bound to it", () => {
    // workerd's ExecutionContext methods reject a foreign `this`.
    const inner = {
      waitUntil() {},
      passThroughOnException() {},
      props: { tenant: "a" },
      whoAmI(this: unknown) {
        return this === inner;
      },
    };
    const ctx = createCollectingExecutionContext(
      inner,
    ) as unknown as typeof inner;

    expect(ctx.props).toEqual({ tenant: "a" });
    expect(ctx.whoAmI()).toBe(true);
  });
});

describe("runWarmRequest", () => {
  it("sends a cookie-free document GET for the URL, marked in process", async () => {
    let seen: Request | undefined;
    let mark: PrerenderWarmRecord | undefined;
    const ctx = createCollectingExecutionContext();
    const env = { KV: "binding" };
    const fetch = vi.fn(async (request: Request) => {
      seen = request;
      mark = readWarmMark(request);
      return new Response("<html></html>");
    });

    const outcome = await runWarmRequest({
      url: new URL("https://shop.example/products/1?color=red"),
      mode: "replace",
      cacheConfig,
      env,
      ctx,
      fetch,
    });

    expect(seen!.method).toBe("GET");
    expect(seen!.url).toBe("https://shop.example/products/1?color=red");
    const headers: [string, string][] = [];
    seen!.headers.forEach((value, name) => headers.push([name, value]));
    expect(headers).toEqual([["accept", "text/html"]]);
    expect(fetch).toHaveBeenCalledWith(seen, { env, ctx });
    // The handler reads this record off the request and writes to its store.
    expect(mark).toBe(outcome.record);
    expect(outcome.record).toMatchObject({ mode: "replace", cacheConfig });
    expect(outcome.responseStatus).toBe(200);
    expect(outcome.error).toBeUndefined();
  });

  it("starts the request in a later millisecond than the call", async () => {
    // updateTag(tag) then a warm: a store refuses a shell whose capture
    // started in the invalidation's own millisecond.
    for (let i = 0; i < 20; i++) {
      let startedAt = 0;
      const calledAt = Date.now();
      await runWarmRequest({
        url: new URL("https://shop.example/"),
        mode: "replace",
        cacheConfig,
        env: {},
        ctx: createCollectingExecutionContext(),
        fetch: async () => {
          startedAt = Date.now();
          return new Response("ok");
        },
      });
      expect(startedAt).toBeGreaterThan(calledAt);
    }
  });

  it("drains the response body: the render finishes with it", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 3) controller.close();
        else controller.enqueue(new Uint8Array([pulled]));
      },
    });

    await runWarmRequest({
      url: new URL("https://shop.example/"),
      mode: "replace",
      cacheConfig,
      env: {},
      ctx: createCollectingExecutionContext(),
      fetch: async () => new Response(body),
    });

    expect(pulled).toBe(4);
  });

  it("waits for the background work, including work a settled task scheduled", async () => {
    const ctx = createCollectingExecutionContext();
    const first = deferred();
    const second = deferred();
    const order: string[] = [];
    const run = runWarmRequest({
      url: new URL("https://shop.example/"),
      mode: "replace",
      cacheConfig,
      env: {},
      ctx,
      fetch: async (request) => {
        // A deferred cache write whose own completion schedules the store put
        // (cacheRoute's nested waitUntil), and a record written at the end.
        ctx.waitUntil(
          first.promise.then(() => {
            order.push("first");
            ctx.waitUntil(
              second.promise.then(() => {
                order.push("second");
                readWarmMark(request)!.writes.record += 1;
              }),
            );
          }),
        );
        return new Response("ok");
      },
    }).then((outcome) => {
      order.push("settled");
      return outcome;
    });

    first.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual(["first"]);
    second.resolve();

    const outcome = await run;
    expect(order).toEqual(["first", "second", "settled"]);
    expect(outcome.record.writes.record).toBe(1);
  });

  it("reports a handler throw and still waits for what was scheduled", async () => {
    const ctx = createCollectingExecutionContext();
    const boom = new Error("handler threw");
    let settled = false;

    const outcome = await runWarmRequest({
      url: new URL("https://shop.example/"),
      mode: "replace",
      cacheConfig,
      env: {},
      ctx,
      fetch: async () => {
        ctx.waitUntil(
          Promise.resolve().then(() => {
            settled = true;
          }),
        );
        throw boom;
      },
    });

    expect(outcome.error).toBe(boom);
    expect(outcome.responseStatus).toBeUndefined();
    expect(settled).toBe(true);
  });

  it("reports a body that fails mid-stream, with the status it answered", async () => {
    const boom = new Error("stream error");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(boom);
      },
    });

    const outcome = await runWarmRequest({
      url: new URL("https://shop.example/"),
      mode: "replace",
      cacheConfig,
      env: {},
      ctx: createCollectingExecutionContext(),
      fetch: async () => new Response(body),
    });

    expect(outcome.responseStatus).toBe(200);
    expect(outcome.error).toBe(boom);
  });

  it("stops waiting at its budget and reports what landed so far", async () => {
    const ctx = createCollectingExecutionContext();
    const never = new Promise<void>(() => {});

    const outcome = await runWarmRequest({
      url: new URL("https://shop.example/slow"),
      mode: "replace",
      cacheConfig,
      env: {},
      ctx,
      settleBudgetMs: 20,
      fetch: async (request) => {
        readWarmMark(request)!.writes.item += 1;
        ctx.waitUntil(never);
        return new Response(new ReadableStream<Uint8Array>({}));
      },
    });

    expect(outcome.error).toBeInstanceOf(Error);
    expect(String(outcome.error)).toContain("https://shop.example/slow");
    expect(outcome.record.writes.item).toBe(1);
  });
});

describe("warmStatus", () => {
  function outcome(
    patch: Partial<PrerenderWarmRecord> = {},
    rest: Partial<WarmRequestOutcome> = {},
  ): WarmRequestOutcome {
    return {
      record: { ...createWarmRecord("replace", cacheConfig), ...patch },
      responseStatus: 200,
      ...rest,
    };
  }
  const wrote = { record: 1, item: 0, response: 0, shell: 0 };

  it("warmed: a 200 that wrote something", () => {
    expect(warmStatus(outcome({ writes: wrote }))).toBe("warmed");
    expect(
      warmStatus(
        outcome({
          writes: { record: 0, item: 0, response: 0, shell: 1 },
          shell: "stored",
        }),
      ),
    ).toBe("warmed");
  });

  it("skipped-uncached: a 200 that wrote nothing", () => {
    expect(warmStatus(outcome())).toBe("skipped-uncached");
  });

  it("already-fresh: an onlyIfStale warm that wrote nothing", () => {
    expect(warmStatus(outcome({ mode: "fill" }))).toBe("already-fresh");
    expect(warmStatus(outcome({ mode: "fill", shell: "fresh" }))).toBe(
      "already-fresh",
    );
    expect(warmStatus(outcome({ mode: "fill", writes: wrote }))).toBe("warmed");
  });

  it("shell-not-stored: a ppr route whose shell is neither stored nor fresh", () => {
    for (const shell of [
      "refused",
      "no-shell",
      "not-eligible",
      "skipped-capacity",
      "skipped-queue-timeout",
      "error",
    ] as const) {
      // Even when another cache wrote: the route declared a shell.
      expect(warmStatus(outcome({ shell, writes: wrote })), shell).toBe(
        "shell-not-stored",
      );
    }
  });

  it("render-failed: a throw, a non-200, or a reported render error", () => {
    expect(warmStatus(outcome({ writes: wrote }, { error: new Error() }))).toBe(
      "render-failed",
    );
    expect(
      warmStatus(outcome({ writes: wrote }, { responseStatus: 302 })),
    ).toBe("render-failed");
    expect(
      warmStatus(outcome({ writes: wrote }, { responseStatus: 404 })),
    ).toBe("render-failed");
    expect(
      warmStatus(outcome({ writes: wrote, renderErrors: [new Error("x")] })),
    ).toBe("render-failed");
    expect(
      warmStatus(outcome({ writes: wrote }, { responseStatus: undefined })),
    ).toBe("render-failed");
  });

  it("skipped-personalized wins: the guard's throw usually fails the render too", () => {
    expect(
      warmStatus(
        outcome(
          { identity: "cookies()", shell: "refused", refusal: "identity" },
          {
            responseStatus: 500,
            error: new Error("cookies() cannot be called"),
          },
        ),
      ),
    ).toBe("skipped-personalized");
  });
});

describe("warmCaches", () => {
  it("is the record's per-cache detail, without the internals", () => {
    const record: PrerenderWarmRecord = {
      ...createWarmRecord("replace", cacheConfig),
      shell: "refused",
      refusal: "identity",
      document: "not-cacheable",
      identity: "cookies()",
      renderErrors: [],
    };
    record.writes.item = 2;

    const caches = warmCaches(record);
    expect(caches).toEqual({
      writes: { record: 0, item: 2, response: 0, shell: 0 },
      shell: "refused",
      refusal: "identity",
      document: "not-cacheable",
    });
    // A copy: a late write does not change a result already returned.
    record.writes.item = 3;
    expect(caches.writes.item).toBe(2);
  });

  it("omits what the request never reached", () => {
    expect(warmCaches(createWarmRecord("replace", cacheConfig))).toEqual({
      writes: { record: 0, item: 0, response: 0, shell: 0 },
    });
  });
});
