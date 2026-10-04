/**
 * A cache() among a path's children caches that path: the route segment and
 * its own layouts and parallels. Entries above the path stay live (#911's
 * boundary), and every sibling declared after the cache() still attaches to
 * the path (issue #912). Before, the call created an orphan cache entry that
 * was never an ancestor of the route: no scope was built, nothing was stored,
 * and a layout declared after it was re-parented onto that entry and never
 * rendered.
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
import { createRouter } from "../../../router.js";
import { createLoader } from "../../../loader.rsc.js";
import { buildRouterTrieFromUrlpatterns } from "../../../rsc/manifest-init.js";
import { MemorySegmentCacheStore } from "../../../cache/memory-segment-store.js";
import type { CachedEntryData } from "../../../cache/types.js";
import {
  createRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../../server/request-context.js";

const calls = { shell: 0, page: 0, chrome: 0, side: 0, loader: 0 };
let headerWriteThrew: boolean | undefined;

const PathLoader = (createLoader as Function)(
  async () => ({ n: ++calls.loader }),
  undefined,
  "test#CachePathChildrenLoader",
);

let router: any;
let store: MemorySegmentCacheStore;
const writes = new Map<string, string[]>();

function text(n: number, label: string) {
  return createElement("div", null, `${label}-${n}`);
}

beforeAll(async () => {
  store = new MemorySegmentCacheStore();
  const set = store.set.bind(store);
  store.set = async (
    key: string,
    data: CachedEntryData,
    ttl: number,
    swr?: number,
  ) => {
    writes.set(
      key,
      data.segments.map((s) => s.metadata.id),
    );
    return set(key, data, ttl, swr);
  };
  router = createRouter({} as any);
  router.routes(({ path, cache, layout, parallel, loader }: any) => [
    layout(
      () => text(++calls.shell, "shell"),
      () => [
        path(
          "/pc",
          () => text(++calls.page, "page"),
          { name: "pcPage" },
          () => [
            cache({ ttl: 60, store }),
            layout(() => text(++calls.chrome, "chrome")),
            parallel({ "@side": () => text(++calls.side, "side") }),
            loader(PathLoader),
          ],
        ),
        path(
          "/pc-wrap",
          () => text(++calls.page, "wrap"),
          { name: "pcWrap" },
          () => [
            cache({ ttl: 60, store }, () => [
              layout(() => text(++calls.chrome, "chrome")),
            ]),
          ],
        ),
        path(
          "/pc-guard",
          (ctx: any) => {
            try {
              ctx.headers.set("x-guard", "1");
              headerWriteThrew = false;
            } catch {
              headerWriteThrew = true;
            }
            return text(++calls.page, "guard");
          },
          { name: "pcGuard" },
          () => [cache({ ttl: 60, store })],
        ),
        cache({ ttl: 60, store }, () => [
          path(
            "/pc-off",
            () => text(++calls.page, "off"),
            { name: "pcOff" },
            () => [cache(false), layout(() => text(++calls.chrome, "chrome"))],
          ),
        ]),
      ],
    ),
  ]);
  await buildRouterTrieFromUrlpatterns(router);
});

beforeEach(async () => {
  await store.clear();
  writes.clear();
});

type Served = Array<{ id: string; type: string; text: unknown }>;

async function serve(pathname: string): Promise<Served> {
  const request = new Request(`https://example.com${pathname}`, {
    headers: { accept: "text/html" },
  });
  const reqCtx = createRequestContext({
    env: {},
    request,
    url: new URL(request.url),
    variables: {},
  } as any) as RequestContext<any>;
  let segments: any[] = [];
  await runWithRequestContext(reqCtx, async () => {
    const result = await router.match(request, { env: {} });
    segments = result.segments;
    reqCtx._handleStore.seal();
    await reqCtx._handleStore.fullySettled;
    for (const cb of reqCtx._onResponseCallbacks.splice(0)) {
      cb(new Response(null, { status: 200 }));
    }
    const tasks = reqCtx._pendingBackgroundTasks!;
    for (let i = 0; i < tasks.length; i++) await tasks[i];
  });
  return segments
    .filter((s) => s.type !== "loader")
    .map((s) => ({
      id: s.id,
      type: s.type,
      text: s.component?.props?.children ?? null,
    }));
}

function find(served: Served, prefix: string) {
  return served.find(
    (s) => typeof s.text === "string" && s.text.startsWith(prefix),
  );
}

describe("cache() among a path's children", () => {
  it("renders a layout declared after the cache()", async () => {
    const miss = await serve("/pc");
    expect(find(miss, "chrome-")?.text).toBe(`chrome-${calls.chrome}`);
    expect(find(miss, "side-")?.text).toBe(`side-${calls.side}`);
  });

  it("stores the path's own segments and none from above it", async () => {
    const miss = await serve("/pc");
    expect(writes.size).toBe(1);
    const [key, stored] = [...writes.entries()][0]!;
    expect(key.startsWith("doc:")).toBe(true);
    const routeId = miss.find((s) => s.type === "route")!.id;
    expect(stored).toContain(routeId);
    expect(stored).toContain(find(miss, "chrome-")!.id);
    expect(stored).toContain(find(miss, "side-")!.id);
    expect(stored).not.toContain(find(miss, "shell-")!.id);
  });

  it("serves the path from cache on a HIT while the layout above it and the loader run", async () => {
    const miss = await serve("/pc");
    const before = { ...calls };
    const hit = await serve("/pc");

    expect(calls.page).toBe(before.page);
    expect(calls.chrome).toBe(before.chrome);
    expect(calls.side).toBe(before.side);
    expect(find(hit, "page-")?.text).toBe(find(miss, "page-")?.text);
    expect(find(hit, "chrome-")?.text).toBe(find(miss, "chrome-")?.text);

    expect(calls.shell).toBe(before.shell + 1);
    expect(find(hit, "shell-")?.text).toBe(`shell-${calls.shell}`);
    expect(calls.loader).toBe(before.loader + 1);

    expect(hit.map((s) => s.id)).toEqual(miss.map((s) => s.id));
  });

  it("the wrapper form caches the path the same way and renders what it wraps", async () => {
    const miss = await serve("/pc-wrap");
    expect(find(miss, "chrome-")).toBeDefined();
    const stored = [...writes.values()][0]!;
    expect(stored).toContain(miss.find((s) => s.type === "route")!.id);
    expect(stored).toContain(find(miss, "chrome-")!.id);
    const before = calls.page;
    await serve("/pc-wrap");
    expect(calls.page).toBe(before);
  });

  it("guards the path's handler like any handler inside a cache() boundary", async () => {
    headerWriteThrew = undefined;
    await serve("/pc-guard");
    expect(headerWriteThrew).toBe(true);
  });

  it("cache(false) among a path's children opts the path out of an enclosing cache()", async () => {
    const first = await serve("/pc-off");
    expect(find(first, "chrome-")).toBeDefined();
    const before = calls.page;
    await serve("/pc-off");
    expect(writes.size).toBe(0);
    expect(calls.page).toBe(before + 1);
  });
});
