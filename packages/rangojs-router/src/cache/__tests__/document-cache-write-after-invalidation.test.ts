/**
 * The document cache does not store a render that started before another
 * request invalidated one of its tags (issue #977): the store stamps the
 * entry when it is written, so the pre-invalidation document would be served
 * as newer than the invalidation until s-maxage + swr.
 */
import { describe, it, expect, vi } from "vitest";
import { createDocumentCacheMiddleware } from "../document-cache.js";
import { MemorySegmentCacheStore } from "../memory-segment-store.js";
import { cacheTag } from "../cache-tag.js";
import { updateTag } from "../tag-invalidation.js";
import { responseStartedAt } from "../invalidation-order.js";
import type { MiddlewareContext } from "../../router/middleware.js";
import {
  createRequestContext,
  runWithRequestContext,
  type ExecutionContext,
  type RequestContext,
} from "../../server/request-context.js";

const url = new URL("http://localhost/doc-held");

function context(store: MemorySegmentCacheStore, tasks: Promise<unknown>[]) {
  const request = new Request(url, { headers: { accept: "text/html" } });
  return createRequestContext({
    env: {},
    request,
    url,
    variables: {},
    cacheStore: store,
    executionContext: {
      waitUntil: (task: Promise<unknown>) => {
        tasks.push(task);
      },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext,
  }) as RequestContext<unknown>;
}

describe("document cache: a render started before another request's updateTag() (#977)", () => {
  it("is not stored; the next request renders the new data", async () => {
    const store = new MemorySegmentCacheStore();
    // The memory store refuses a late write itself (#1068): assert the gate
    // kept the write from reaching it.
    const putResponse = vi.spyOn(store, "putResponse");
    let source = "old";
    let gate: Promise<void> = Promise.resolve();
    let renders = 0;
    const middleware = createDocumentCacheMiddleware();

    /** One document request; resolves with its body and cache status. */
    async function serve(): Promise<[string, string | null]> {
      const tasks: Promise<unknown>[] = [];
      const reqCtx = context(store, tasks);
      const middlewareCtx = {
        request: reqCtx.request,
        url,
        env: {},
        var: {},
        get: vi.fn(),
        set: vi.fn(),
      } as unknown as MiddlewareContext<any>;
      const result = await runWithRequestContext(reqCtx, async () => {
        const response = await middleware(middlewareCtx, async () => {
          renders++;
          cacheTag("doc-held");
          const value = source;
          await gate;
          return new Response(`doc:${value}`, {
            headers: { "Cache-Control": "s-maxage=60" },
          });
        });
        return [
          await response!.text(),
          response!.headers.get("x-document-cache-status"),
        ] as [string, string | null];
      });
      while (tasks.length > 0) await Promise.allSettled(tasks.splice(0));
      return result;
    }

    let release!: () => void;
    gate = new Promise<void>((resolve) => (release = resolve));
    const first = serve();
    await vi.waitFor(() => expect(renders).toBe(1));
    source = "new";
    await runWithRequestContext(context(store, []), () =>
      updateTag("doc-held"),
    );
    release();
    expect(await first).toEqual(["doc:old", "MISS"]);
    expect(putResponse).not.toHaveBeenCalled();

    gate = Promise.resolve();
    expect(await serve()).toEqual(["doc:new", "MISS"]);
    expect(await serve()).toEqual(["doc:new", "HIT"]);
    expect(renders).toBe(2);
  });

  // A middleware ahead of the document cache reads tagged data the document
  // bakes: the render's data is as old as the request.
  it("data an earlier middleware read before the invalidation is not stored", async () => {
    const store = new MemorySegmentCacheStore();
    const putResponse = vi.spyOn(store, "putResponse");
    let source = "old";
    const middleware = createDocumentCacheMiddleware();
    const tasks: Promise<unknown>[] = [];
    const reqCtx = context(store, tasks);
    const middlewareCtx = {
      request: reqCtx.request,
      url,
      env: {},
      var: {},
      get: vi.fn(),
      set: vi.fn(),
    } as unknown as MiddlewareContext<any>;

    const body = await runWithRequestContext(reqCtx, async () => {
      // The earlier middleware.
      cacheTag("doc-early");
      const early = source;
      // Another request changes the data and invalidates meanwhile.
      source = "new";
      await runWithRequestContext(context(store, []), () =>
        updateTag("doc-early"),
      );
      const response = await middleware(
        middlewareCtx,
        async () =>
          new Response(`doc:${early}`, {
            headers: { "Cache-Control": "s-maxage=60" },
          }),
      );
      return response!.text();
    });
    while (tasks.length > 0) await Promise.allSettled(tasks.splice(0));

    expect(body).toBe("doc:old");
    expect(putResponse).not.toHaveBeenCalled();
    expect(await store.getResponse("localhost/doc-held:html")).toBeNull();
  });

  // One document request through the middleware with `render` as the handler.
  // `delayMs` passes between the request's start and the middleware call.
  async function serveDoc(
    store: MemorySegmentCacheStore,
    render: () => Promise<Response>,
    delayMs = 0,
  ): Promise<{ body: string; calledAt: number }> {
    const tasks: Promise<unknown>[] = [];
    const reqCtx = context(store, tasks);
    const middlewareCtx = {
      request: reqCtx.request,
      url,
      env: {},
      var: {},
      get: vi.fn(),
      set: vi.fn(),
    } as unknown as MiddlewareContext<any>;
    const middleware = createDocumentCacheMiddleware();
    const out = await runWithRequestContext(reqCtx, async () => {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const calledAt = Date.now();
      const response = await middleware(middlewareCtx, render);
      return { body: await response!.text(), calledAt };
    });
    while (tasks.length > 0) await Promise.allSettled(tasks.splice(0));
    return out;
  }

  function forceStale(store: MemorySegmentCacheStore): void {
    const getResponse = store.getResponse.bind(store);
    store.getResponse = async (key) => {
      const hit = await getResponse(key);
      return hit && { ...hit, shouldRevalidate: true };
    };
  }

  const docResponse = (body: string) =>
    new Response(body, { headers: { "Cache-Control": "s-maxage=60" } });

  it("STALE: a refresh started before the invalidation is not written (the gate itself)", async () => {
    const store = new MemorySegmentCacheStore();
    let source = "old";
    let gate: Promise<void> = Promise.resolve();
    let renders = 0;
    const render = async () => {
      renders++;
      cacheTag("doc-stale");
      const value = source;
      await gate;
      return docResponse(`doc:${value}`);
    };
    await serveDoc(store, render);
    forceStale(store);

    const putResponse = vi.spyOn(store, "putResponse");
    let release!: () => void;
    gate = new Promise<void>((resolve) => (release = resolve));
    const second = serveDoc(store, render);
    await vi.waitFor(() => expect(renders).toBe(2));
    source = "new";
    await runWithRequestContext(context(store, []), () =>
      updateTag("doc-stale"),
    );
    release();
    expect((await second).body).toBe("doc:old");
    expect(putResponse).not.toHaveBeenCalled();
  });

  // #1068: the document's stamp is the request's start (the gate's start),
  // not the write's or the refresh's: a stale refresh re-runs the handler
  // over data earlier middleware read at request start. The request starts
  // 30 ms before the middleware runs, so a stamp taken in the middleware, or
  // in the refresh, is later than the request's.
  it.each(["MISS", "STALE"] as const)(
    "%s: putResponse receives the response marked with the request's start",
    async (kind) => {
      const store = new MemorySegmentCacheStore();
      const starts: (number | undefined)[] = [];
      const putResponse = store.putResponse.bind(store);
      store.putResponse = async (key, response, ...rest) => {
        starts.push(responseStartedAt(response));
        return putResponse(key, response, ...rest);
      };
      const render = async () => {
        cacheTag("doc-stamp");
        return docResponse("doc");
      };
      const before = Date.now();
      const calls = [await serveDoc(store, render, 30)];
      if (kind === "STALE") {
        forceStale(store);
        calls.push(await serveDoc(store, render, 30));
      }

      expect(starts.length).toBe(calls.length);
      starts.forEach((at, i) => {
        expect(at).toBeGreaterThanOrEqual(before);
        expect(at).toBeLessThanOrEqual(calls[i]!.calledAt - 25);
      });
    },
  );
});
