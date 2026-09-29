/**
 * Issue #957: a render-called cacheTag() must tag the PPR shell even when the
 * capture's match replays the route's cache() record.
 *
 * A ppr route's cache() record covers the whole chain (route-snapshot.ts
 * buildEntriesAndCacheScope), so a capture whose match HITs that record
 * replays the layout above the cache() without running it. The layout's
 * render-called cacheTag() then never records onto the capture's
 * _requestTags, the shell is stored untagged, and updateTag() of that tag can
 * never evict it (CFCacheStore.isGloballyInvalidated short-circuits on an
 * untagged entry). In production the capture HITs the record whenever the
 * foreground's deferred ring-3 write lands before the capture's match — e.g.
 * a capture queued behind another one in capture-queue.ts.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

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
import { buildRouterTrieFromUrlpatterns } from "../manifest-init.js";
import { MemorySegmentCacheStore } from "../../cache/memory-segment-store.js";
import { cacheTag } from "../../cache/cache-tag.js";
import { runShellCapture } from "../shell-capture.js";
import {
  createRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../server/request-context.js";
import type { ShellCacheEntry } from "../../cache/types.js";
import type { HandlerContext } from "../handler-context.js";
import type { SSRModule } from "../types.js";

const LAYOUT_TAG = "ppr-layout-tag";
const calls = { layout: 0 };

let router: any;
let store: MemorySegmentCacheStore;

beforeAll(async () => {
  store = new MemorySegmentCacheStore();
  router = createRouter({} as any);
  router.routes(({ path, cache, layout }: any) => [
    layout(
      () => {
        calls.layout++;
        // Render-callable form (#648): no cache()/"use cache" scope is active
        // here, so the tag records onto the request's document tag set.
        cacheTag(LAYOUT_TAG);
        return createElement("div", null, `layout-${calls.layout}`);
      },
      () => [
        cache({ ttl: 60 }, () => [
          path("/ppr", () => createElement("p", null, "page"), {
            name: "ring3TagsPpr",
            ppr: true,
          }),
        ]),
      ],
    ),
  ]);
  await buildRouterTrieFromUrlpatterns(router);
});

beforeEach(async () => {
  await store.clear();
  calls.layout = 0;
});

function makeRequestContext(url: string): RequestContext<any> {
  const request = new Request(url, { headers: { accept: "text/html" } });
  const reqCtx = createRequestContext({
    env: {},
    request,
    url: new URL(url),
    variables: {},
  } as any) as RequestContext<any>;
  (reqCtx as any)._cacheStore = store;
  (reqCtx as any)._reportBackgroundError = vi.fn();
  return reqCtx;
}

/**
 * A foreground document render of `url`: match, settle handles, fire the
 * response callbacks (the ring-3 cache write is gated behind onResponse), and
 * await the deferred writes so the cache() record has landed.
 */
async function serveForeground(url: string): Promise<void> {
  const reqCtx = makeRequestContext(url);
  await runWithRequestContext(reqCtx, async () => {
    await router.match(reqCtx.request, { env: {} });
    reqCtx._handleStore.seal();
    await reqCtx._handleStore.fullySettled;
    for (const cb of reqCtx._onResponseCallbacks.splice(0)) {
      cb(new Response(null, { status: 200 }));
    }
    const tasks = reqCtx._pendingBackgroundTasks!;
    for (let i = 0; i < tasks.length; i++) await tasks[i];
  });
}

/** Run the real background capture for `url`; return the tags putShell got. */
async function captureTags(url: string): Promise<string[] | undefined> {
  const putShell = vi.fn(
    async (
      _key: string,
      _entry: ShellCacheEntry,
      _ttl?: number,
      _swr?: number,
      _tags?: string[],
    ) => "stored" as const,
  );
  const ctx = {
    version: "v-test",
    router: {
      id: "test-router",
      basename: undefined,
      rootLayout: undefined,
      resolvedStateCookieName: "rango-state",
      themeConfig: undefined,
      prefetchCacheTTL: 0,
      prefetchCacheSize: 0,
      prefetchConcurrency: 0,
      warmupEnabled: true,
      strictMode: false,
      onError: undefined,
      match: (request: Request, opts: { env: unknown }) =>
        router.match(request, opts),
    },
    callOnError: vi.fn(),
    renderToReadableStream: vi.fn(
      () =>
        new ReadableStream<Uint8Array>({
          start(c) {
            c.close();
          },
        }),
    ),
  } as unknown as HandlerContext<any>;
  const ssrModule = {
    renderHTML: vi.fn(),
    resumeShellHTML: vi.fn(),
    captureShellHTML: vi.fn(async () => ({
      prelude: new TextEncoder().encode("<html><body>shell</body></html>"),
      postponed: null,
    })),
  } as unknown as SSRModule;
  const reqCtx = makeRequestContext(url);

  const outcome = await runShellCapture(
    ctx,
    reqCtx.request,
    {},
    new URL(url),
    reqCtx,
    ssrModule,
    {
      key: `${url}:shell`,
      buildVersion: "test-build",
      ttl: 300,
      store: { putShell } as any,
    },
    0,
  );
  expect(outcome).toBe("stored");
  expect(putShell).toHaveBeenCalledTimes(1);
  return putShell.mock.calls[0]![4];
}

describe("PPR capture over a warm cache() record keeps render-called shell tags (#957)", () => {
  it("control: a capture that MISSes the cache() record runs the layout and tags the shell", async () => {
    const tags = await captureTags("https://example.com/ppr?v=cold");

    expect(calls.layout).toBe(1);
    expect(tags ?? []).toContain(LAYOUT_TAG);
  });

  it("a capture that HITs the foreground's cache() record still tags the shell with the layout's render-called tag", async () => {
    const url = "https://example.com/ppr?v=warm";
    // The foreground MISS runs the layout (records the tag) and writes the
    // whole-chain cache() record; the capture then matches with it warm.
    await serveForeground(url);
    expect(calls.layout).toBe(1);

    const tags = await captureTags(url);

    // The capture replayed the record: the layout did not run again.
    expect(calls.layout).toBe(1);
    // Without the tag the shell survives updateTag(LAYOUT_TAG) forever.
    expect(tags ?? []).toContain(LAYOUT_TAG);
  });
});
