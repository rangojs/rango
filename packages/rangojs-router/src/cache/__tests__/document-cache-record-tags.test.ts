/**
 * Issue #957, document-cache twin: a document the document cache stores while
 * the route's cache() record HITs must still carry the tags the record's
 * content recorded with the render-callable cacheTag(). The document cache
 * snapshots the request's tag set after the body drains; on a record HIT the
 * layout does not run, so before the record carried those tags the document
 * entry was stored without them and updateTag() could not evict it.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";

// JSON stand-in for the Flight codec (plugin-rsc is a virtual module).
function pluginRscMock() {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return {
    createTemporaryReferenceSet: () => new Set(),
    renderToReadableStream: (value: unknown) => {
      const bytes = encoder.encode(JSON.stringify(value) ?? "null");
      return new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },
    createFromReadableStream: async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      let result = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        result += decoder.decode(value, { stream: true });
      }
      return JSON.parse(result + decoder.decode());
    },
  };
}
vi.mock("@vitejs/plugin-rsc/rsc/server", pluginRscMock);
vi.mock("@vitejs/plugin-rsc/rsc/client", pluginRscMock);

import { createElement } from "react";
import { createRouter } from "../../router.js";
import { buildRouterTrieFromUrlpatterns } from "../../rsc/manifest-init.js";
import { MemorySegmentCacheStore } from "../memory-segment-store.js";
import { createDocumentCacheMiddleware } from "../document-cache.js";
import { cacheTag } from "../cache-tag.js";
import type { MiddlewareContext } from "../../router/middleware.js";
import {
  createRequestContext,
  runWithRequestContext,
  type ExecutionContext,
  type RequestContext,
} from "../../server/request-context.js";

const LAYOUT_TAG = "doc-layout-tag";
const calls = { layout: 0 };

let router: any;

beforeAll(async () => {
  router = createRouter({} as any);
  // The tagging layout sits INSIDE the cache() boundary: a non-ppr record
  // covers only its boundary's subtree, and a layout above it re-runs on
  // every HIT (#911).
  router.routes(({ layout, cache, path }: any) => [
    cache({ ttl: 600 }, () => [
      layout(
        () => {
          calls.layout++;
          cacheTag(LAYOUT_TAG);
          return createElement("div", null, `layout-${calls.layout}`);
        },
        () => [
          path("/doc", () => createElement("p", null, "page"), {
            name: "docRecordTags",
          }),
        ],
      ),
    ]),
  ]);
  await buildRouterTrieFromUrlpatterns(router);
});

/**
 * One document request through the document cache middleware, whose next()
 * runs the real match: the route's cache() record write fires from the
 * response callbacks, exactly as the RSC handler drives it.
 */
async function serveDocument(store: MemorySegmentCacheStore): Promise<void> {
  const url = new URL("http://localhost/doc");
  const request = new Request(url, { headers: { accept: "text/html" } });
  const tasks: Promise<unknown>[] = [];
  const reqCtx = createRequestContext({
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
  const middlewareCtx = {
    request,
    url,
    env: {},
    var: {},
    get: vi.fn(),
    set: vi.fn(),
  } as unknown as MiddlewareContext<any>;
  await runWithRequestContext(reqCtx, async () => {
    const response = await createDocumentCacheMiddleware()(
      middlewareCtx,
      async () => {
        await router.match(request, { env: {} });
        reqCtx._handleStore.seal();
        await reqCtx._handleStore.fullySettled;
        const document = new Response("<html>doc</html>", {
          headers: { "Cache-Control": "s-maxage=60" },
        });
        for (const cb of reqCtx._onResponseCallbacks.splice(0)) cb(document);
        return document;
      },
    );
    await response?.text();
  });
  while (tasks.length > 0) await Promise.allSettled(tasks.splice(0));
}

describe("document cache over a warm cache() record (#957)", () => {
  it("tags the document with the record's render-called tags when the record HITs", async () => {
    const store = new MemorySegmentCacheStore();
    const documentTags: Array<string[] | undefined> = [];
    const putResponse = store.putResponse.bind(store);
    store.putResponse = async (key, response, ttl, swr, tags) => {
      documentTags.push(tags);
      return putResponse(key, response, ttl, swr, tags);
    };

    // Document and record both MISS: the layout runs and tags the document.
    await serveDocument(store);
    expect(calls.layout).toBe(1);
    expect(documentTags[0]).toContain(LAYOUT_TAG);

    // The document entry expires (s-maxage 60) while the record (ttl 600) is
    // still warm: the next document MISSes, the record HITs.
    store.getResponse = async () => null;
    await serveDocument(store);
    expect(calls.layout).toBe(1);
    expect(documentTags[1] ?? []).toContain(LAYOUT_TAG);

    // So updateTag() evicts that document.
    await store.invalidateTags([LAYOUT_TAG]);
    const entries = (
      store as unknown as { responseCache: Map<string, unknown> }
    ).responseCache;
    expect(entries.size).toBe(0);
  });
});
