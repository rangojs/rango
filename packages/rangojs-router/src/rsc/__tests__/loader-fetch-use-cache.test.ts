/**
 * A fetchable loader passing its ctx to a "use cache" function (issue #940),
 * through the production handleLoaderFetch with a real RequestContext. The
 * ctx is a spread of the request context, so it carries the NOCACHE_SYMBOL
 * brand and keys by route fields, which never included the request body: two
 * POSTs with different bodies shared one entry. A ctx carrying a body or
 * form data now runs the call uncached; GET params still key the entry. The
 * Flight codec is replaced by JSON (plugin-rsc is a virtual module).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

function pluginRscMock() {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return {
    createTemporaryReferenceSet: () => new Set(),
    createClientTemporaryReferenceSet: () => new Set(),
    encodeReply: async (args: unknown[]) => JSON.stringify(args),
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

vi.mock("../../server/loader-registry.js", () => ({
  getLoaderLazy: vi.fn(),
}));

import { handleLoaderFetch } from "../loader-fetch.js";
import { getLoaderLazy } from "../../server/loader-registry.js";
import { registerCachedFunction } from "../../cache/cache-runtime.js";
import { MemorySegmentCacheStore } from "../../cache/memory-segment-store.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../server/request-context.js";

let store: MemorySegmentCacheStore;
let calls = 0;

// async function describeInput(ctx) { "use cache"; ... }
const describeInput = registerCachedFunction(
  async (ctx: any) => {
    calls++;
    const form = ctx.formData?.get("q");
    return `${ctx.method}:${ctx.params.id ?? ""}:${JSON.stringify(ctx.body ?? form ?? null)}`;
  },
  "test#940:fetchable",
  "default",
);

beforeEach(() => {
  store = new MemorySegmentCacheStore();
  calls = 0;
  vi.mocked(getLoaderLazy).mockResolvedValue({
    fn: (ctx: any) => describeInput(ctx),
    middleware: [],
    fetchable: true,
  } as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** POST/GET the fetchable loader endpoint; returns the loader's result. */
async function fetchLoader(init: RequestInit, query = ""): Promise<unknown> {
  const url = new URL(
    `https://shop.example/p?_rsc_loader=test%23940%3Aloader${query}`,
  );
  const request = new Request(url, init);
  const reqCtx = createRequestContext({
    env: {},
    request,
    url,
    variables: {},
    cacheStore: store,
    cacheProfiles: { default: { ttl: 60 } },
  });
  let loaderResult: unknown;
  const handlerCtx = {
    renderToReadableStream: (payload: { loaderResult: unknown }) => {
      loaderResult = payload.loaderResult;
      return new ReadableStream();
    },
    callOnError: vi.fn(),
    getRequiredRouteMap: () => ({}),
  } as any;
  await runWithRequestContext(reqCtx, async () => {
    const response = await handleLoaderFetch(handlerCtx, request, {}, url, {});
    expect(response.status).toBe(200);
    const tasks = reqCtx._pendingBackgroundTasks ?? [];
    for (let i = 0; i < tasks.length; i++) await tasks[i];
  });
  return loaderResult;
}

const postJson = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ params: { id: "1" }, body }),
});

describe('fetchable loader ctx passed to "use cache" (#940)', () => {
  it("POSTs with different JSON bodies do not share an entry", async () => {
    expect(await fetchLoader(postJson({ qty: 1 }))).toBe('POST:1:{"qty":1}');
    expect(await fetchLoader(postJson({ qty: 2 }))).toBe('POST:1:{"qty":2}');
    expect(calls).toBe(2);
  });

  it("POSTs with different form data do not share an entry", async () => {
    const post = (q: string): RequestInit => {
      const form = new FormData();
      form.set("q", q);
      return { method: "POST", body: form };
    };
    expect(await fetchLoader(post("a"))).toBe('POST::"a"');
    expect(await fetchLoader(post("b"))).toBe('POST::"b"');
    expect(calls).toBe(2);
  });

  it("GET params still key the entry", async () => {
    const get = (id: string) =>
      fetchLoader(
        {},
        `&_rsc_loader_params=${encodeURIComponent(JSON.stringify({ id }))}`,
      );
    expect(await get("1")).toBe("GET:1:null");
    expect(await get("1")).toBe("GET:1:null");
    expect(await get("2")).toBe("GET:2:null");
    expect(calls).toBe(2);
  });
});
