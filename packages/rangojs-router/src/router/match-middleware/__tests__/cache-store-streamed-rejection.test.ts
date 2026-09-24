/**
 * A streamed handler (a route, parallel slot or intercept under loading())
 * that rejects after resolution returned is not written to the route cache.
 *
 * Its segment's component is the pending handler promise, so no status is set
 * at resolution: withCacheStore's MISS gate (`response.status !== 200`) sees
 * 200, and a background re-render (stale-hit refresh, proactive caching) sets
 * none either. The write is refused one level down: serializeSegments
 * (segment-codec.ts) awaits a Promise component before encoding it, the
 * rejection throws out of cacheRoute's serialize step, and cacheRoute
 * reports it (reportCacheError) without calling store.set. Handing the
 * promise to the Flight encoder instead would encode the rejection as an
 * error row (`1:E{...}`) and cache it.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";

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
import { buildRouterTrieFromUrlpatterns } from "../../../rsc/manifest-init.js";
import { MemorySegmentCacheStore } from "../../../cache/memory-segment-store.js";
import {
  createRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../../server/request-context.js";

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
}

type Kind = "route" | "slot" | "modal";
const calls: Record<Kind, number> = { route: 0, slot: 0, modal: 0 };
let fail = false;
let content = "v1";
// Opened once the response exists, so every streamed handler settles after
// resolution returned and after the onResponse write gate ran.
let release = gate();

async function streamed(kind: Kind) {
  calls[kind]++;
  await release.promise;
  if (fail) throw new Error(`${kind} upstream down`);
  return createElement("div", null, `${kind}-${content}`);
}

const skeleton = createElement("p", null, "skeleton");

let router: any;
let store: MemorySegmentCacheStore;
let writes: string[] = [];
let serveStale = false;
let consoleError: MockInstance<typeof console.error>;

beforeAll(async () => {
  store = new MemorySegmentCacheStore();
  const get = store.get.bind(store);
  store.get = async (key: string) => {
    const hit = await get(key);
    return hit && serveStale ? { ...hit, shouldRevalidate: true } : hit;
  };
  const set = store.set.bind(store);
  store.set = async (key, ...rest) => {
    writes.push(key);
    return set(key, ...rest);
  };
  router = createRouter({} as any);
  router.routes(
    ({ path, cache, layout, loading, parallel, intercept }: any) => [
      cache({ ttl: 60, store }, () => [
        layout(createElement("div", null, "shell"), () => [
          path("/", createElement("div", null, "home"), { name: "srHome" }),
          path(
            "/product",
            () => streamed("route"),
            { name: "srProduct" },
            () => [loading(skeleton)],
          ),
          path(
            "/slot",
            createElement("div", null, "slot-page"),
            { name: "srSlot" },
            () => [
              parallel({ "@side": () => streamed("slot") }, () => [
                loading(skeleton),
              ]),
            ],
          ),
          path("/photo", createElement("div", null, "photo"), {
            name: "srPhoto",
          }),
          intercept(
            "@modal",
            "srPhoto",
            () => streamed("modal"),
            () => [loading(skeleton)],
          ),
        ]),
      ]),
    ],
  );
  await buildRouterTrieFromUrlpatterns(router);
});

beforeEach(async () => {
  await store.clear();
  writes = [];
  fail = false;
  content = "v1";
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

interface Served {
  /** reqCtx.res.status when the onResponse write gate ran. */
  status: number;
  /** Whether each streamed component was still pending when resolution returned. */
  pendingAtResolution: boolean[];
  segments: Array<{ id: string; type: string; slot?: string; component?: any }>;
  writes: string[];
}

// A settled promise wins against a macrotask; a pending one loses.
async function isPending(value: Promise<unknown>): Promise<boolean> {
  const settled = Symbol();
  const winner = await Promise.race([
    value.then(
      () => settled,
      () => settled,
    ),
    new Promise((r) => setTimeout(r, 0)),
  ]);
  return winner !== settled;
}

async function serve(
  pathname: string,
  partial?: { clientSegments?: string[]; from?: string },
): Promise<Served> {
  const request = partial
    ? new Request(
        `https://example.com${pathname}?_rsc_partial` +
          (partial.clientSegments
            ? `&_rsc_segments=${partial.clientSegments.join(",")}`
            : ""),
        {
          headers: {
            accept: "text/x-component",
            "X-RSC-Router-Client-Path": `https://example.com${partial.from ?? "/"}`,
          },
        },
      )
    : new Request(`https://example.com${pathname}`, {
        headers: { accept: "text/html" },
      });
  const reqCtx = createRequestContext({
    env: {},
    request,
    url: new URL(request.url),
    variables: {},
  } as any) as RequestContext<any>;
  const liveStore = reqCtx._handleStore;
  const writesBefore = writes.length;
  release = gate();
  let status = 0;
  let segments: Served["segments"] = [];
  const pendingAtResolution: boolean[] = [];
  await runWithRequestContext(reqCtx, async () => {
    const result = partial
      ? await router.matchPartial(request, { env: {} })
      : await router.match(request, { env: {} });
    segments = result.segments;
    for (const s of segments) {
      if (s.component instanceof Promise) {
        pendingAtResolution.push(await isPending(s.component));
      }
    }
    // The streamed response exists before its handler settles.
    status = reqCtx.res.status;
    for (const cb of reqCtx._onResponseCallbacks.splice(0)) {
      cb(new Response(null, { status }));
    }
    liveStore.seal();
    release.open();
    const tasks = reqCtx._pendingBackgroundTasks!;
    for (let i = 0; i < tasks.length; i++) await tasks[i];
  });
  return {
    status,
    pendingAtResolution,
    segments,
    writes: writes.slice(writesBefore),
  };
}

function text(
  served: Served,
  pick: (s: Served["segments"][number]) => boolean,
) {
  return served.segments.find(pick)?.component?.props?.children;
}

function failedWriteLogs(): string[] {
  return consoleError.mock.calls
    .filter((args) => String(args[0]).includes("[CacheScope] Failed to cache"))
    .map((args) => (args[1] as Error).message);
}

describe("a streamed handler that rejects after resolution is not written to the route cache", () => {
  it("MISS: nothing is written; the next request is a MISS", async () => {
    fail = true;
    const miss = await serve("/product");
    expect(miss.pendingAtResolution).toEqual([true]);
    expect(miss.status).toBe(200);
    expect(miss.writes).toEqual([]);
    expect(failedWriteLogs()).toEqual(["route upstream down"]);

    fail = false;
    const callsBefore = calls.route;
    const next = await serve("/product");
    expect(calls.route).toBe(callsBefore + 1);
    // Control: the same lane writes once the handler resolves.
    expect(next.writes).toHaveLength(1);
  });

  it("stale-hit refresh: nothing is written; the stale entry keeps serving", async () => {
    const miss = await serve("/product");
    expect(miss.writes).toHaveLength(1);

    serveStale = true;
    fail = true;
    const stale = await serve("/product");
    serveStale = false;
    fail = false;
    expect(stale.status).toBe(200);
    expect(stale.writes).toEqual([]);
    expect(failedWriteLogs()).toEqual(["route upstream down"]);

    const callsBefore = calls.route;
    content = "v2";
    const hit = await serve("/product");
    expect(calls.route).toBe(callsBefore);
    expect(text(hit, (s) => s.type === "route")).toBe("route-v1");

    // Control: a refresh that resolves replaces the entry.
    serveStale = true;
    const refreshed = await serve("/product");
    serveStale = false;
    expect(refreshed.writes).toHaveLength(1);
    expect(text(await serve("/product"), (s) => s.type === "route")).toBe(
      "route-v2",
    );
  });

  it("proactive caching: nothing is written when the re-rendered handler rejects", async () => {
    const home = await serve("/");
    const layoutIds = home.segments
      .filter((s) => s.type === "layout")
      .map((s) => s.id);

    fail = true;
    let callsBefore = calls.route;
    const nav = await serve("/product", { clientSegments: layoutIds });
    // The client has the layout, so the write is the proactive re-render's:
    // the handler ran in the foreground (revalidation.ts) and in the
    // re-render (fresh.ts).
    expect(calls.route).toBe(callsBefore + 2);
    expect(nav.status).toBe(200);
    expect(nav.writes).toEqual([]);
    expect(failedWriteLogs()).toEqual(["route upstream down"]);

    fail = false;
    callsBefore = calls.route;
    await serve("/product");
    expect(calls.route).toBe(callsBefore + 1);

    // Control.
    await store.clear();
    const ok = await serve("/product", { clientSegments: layoutIds });
    expect(ok.writes).toHaveLength(1);
  });

  it("partial navigation (revalidation.ts lane): nothing is written", async () => {
    fail = true;
    const nav = await serve("/product", { clientSegments: [] });
    expect(nav.pendingAtResolution).toEqual([true]);
    expect(nav.status).toBe(200);
    expect(nav.writes).toEqual([]);
    expect(failedWriteLogs()).toEqual(["route upstream down"]);

    fail = false;
    const ok = await serve("/product", { clientSegments: [] });
    expect(ok.writes).toHaveLength(1);
  });

  it("parallel slot under loading(): nothing is written", async () => {
    fail = true;
    const miss = await serve("/slot");
    expect(miss.pendingAtResolution).toEqual([true]);
    expect(miss.status).toBe(200);
    expect(miss.writes).toEqual([]);
    expect(failedWriteLogs()).toEqual(["slot upstream down"]);

    fail = false;
    const callsBefore = calls.slot;
    const next = await serve("/slot");
    expect(calls.slot).toBe(callsBefore + 1);
    expect(next.writes).toHaveLength(1);
  });

  it("intercept under loading(): nothing is written", async () => {
    fail = true;
    const nav = await serve("/photo", { from: "/" });
    expect(nav.segments.some((s) => s.slot === "@modal")).toBe(true);
    expect(nav.pendingAtResolution).toEqual([true]);
    expect(nav.status).toBe(200);
    expect(nav.writes).toEqual([]);
    expect(failedWriteLogs()).toEqual(["modal upstream down"]);

    fail = false;
    const ok = await serve("/photo", { from: "/" });
    expect(ok.writes).toHaveLength(1);
  });
});
