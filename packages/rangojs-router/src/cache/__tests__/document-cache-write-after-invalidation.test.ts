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

    gate = Promise.resolve();
    expect(await serve()).toEqual(["doc:new", "MISS"]);
    expect(await serve()).toEqual(["doc:new", "HIT"]);
    expect(renders).toBe(2);
  });

  // A middleware ahead of the document cache reads tagged data the document
  // bakes: the render's data is as old as the request.
  it("data an earlier middleware read before the invalidation is not stored", async () => {
    const store = new MemorySegmentCacheStore();
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
    expect(await store.getResponse("localhost/doc-held:html")).toBeNull();
  });
});
