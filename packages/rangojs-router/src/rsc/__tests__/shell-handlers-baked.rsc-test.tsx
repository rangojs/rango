/**
 * PPR handler output is baked, and a HIT never runs a handler — through the
 * real serve pipeline and real Flight: a MISS schedules the capture, the
 * capture writes its doc record first and renders from it, and a later
 * request is served as a document HIT from the stored entry.
 *
 * The SSR half is stubbed: captureShellHTML records the Flight text that
 * reached it before `quiesce` (the frozen input the prelude is rendered from)
 * and returns a fixed prelude; resumeShellHTML passes the tail's Flight
 * through. So a HIT body is the prelude followed by the tail's Flight bytes,
 * and "what the prelude showed" is the frozen capture input.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import React, { Suspense } from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../../testing/vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../../testing/vitest-stubs/plugin-rsc.js"),
);
vi.mock("../../prerender/store.js", () => ({
  createPrerenderStore: () => ({ get: async () => null }),
}));

import { renderToReadableStream } from "../../testing/vitest-stubs/plugin-rsc.js";
import { createRouter } from "../../router.js";
import { createLoader } from "../../loader.rsc.js";
import { createHandle } from "../../handle.js";
import { cacheTag } from "../../cache/cache-tag.js";
import { createVar, contextSet } from "../../context-var.js";
import { cookies, headers } from "../../server/cookie-store.js";
import { buildRouterTrieFromUrlpatterns } from "../manifest-init.js";
import { handleRscRendering } from "../rsc-rendering.js";
import { MemorySegmentCacheStore } from "../../cache/memory-segment-store.js";
import type {
  CacheItemOptions,
  CacheItemResult,
  ShellCacheEntry,
} from "../../cache/types.js";
import {
  createRequestContext,
  getRequestContext,
  runWithRequestContext,
  setRequestContextParams,
  type RequestContext,
} from "../../server/request-context.js";
import {
  classifyRequest,
  type ClassifyRequestDeps,
} from "../../router/request-classification.js";
import type { HandlerContext } from "../handler-context.js";
import type { RscPayload, SSRModule } from "../types.js";
import type { PartialCacheOptions } from "../../types.js";
import { getStamp, source } from "./fixtures/shell-prune-data.js";

const PRELUDE = "<html><body>FROZEN-PRELUDE</body></html>";

/** Flight text each capture's SSR saw before quiesce, in capture order. */
const frozenInputs: string[] = [];

function makeStore(): {
  store: MemorySegmentCacheStore;
  itemReads: string[];
  dropItems: () => void;
} {
  const store = new MemorySegmentCacheStore();
  const items = new Map<string, Omit<CacheItemResult, "shouldRevalidate">>();
  const itemReads: string[] = [];
  Object.assign(store, {
    async getItem(key: string): Promise<CacheItemResult | null> {
      itemReads.push(key);
      const item = items.get(key);
      return item ? { ...item, shouldRevalidate: false } : null;
    },
    async setItem(
      key: string,
      value: string,
      options?: CacheItemOptions,
    ): Promise<void> {
      items.set(key, { value, handles: options?.handles, tags: options?.tags });
    },
  });
  return { store, itemReads, dropItems: () => items.clear() };
}

async function readAll(body: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(body).text();
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

const ssrModule = {
  async renderHTML(rscStream: ReadableStream<Uint8Array>) {
    await readAll(rscStream);
    return streamOf("<html><body>AXIS-1</body></html>");
  },
  async resumeShellHTML(rscStream: ReadableStream<Uint8Array>) {
    return rscStream;
  },
  async captureShellHTML(
    rscStream: ReadableStream<Uint8Array>,
    options: { quiesce: Promise<unknown> },
  ) {
    const reader = rscStream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    void (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        text += decoder.decode(value, { stream: true });
      }
    })();
    await options.quiesce;
    // The post-quiesce allowance the real capture gives fizz.
    for (let i = 0; i < 16; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    frozenInputs.push(text);
    return { prelude: new TextEncoder().encode(PRELUDE), postponed: null };
  },
} as unknown as SSRModule;

type Router = ReturnType<typeof createRouter>;

function makeCtx(router: Router): HandlerContext<unknown> {
  return {
    version: "v-baked",
    router,
    callOnError: vi.fn(),
    renderToReadableStream: (payload: RscPayload, options?: object) =>
      renderToReadableStream(payload, options),
    loadSSRModule: async () => ssrModule,
    resolveStreamMode: async () => "stream",
  } as unknown as HandlerContext<unknown>;
}

interface ServeInit {
  headers?: Record<string, string>;
  /** Variables middleware would have set, as [var, value, options]. */
  variables?: Array<[unknown, unknown, { cache?: boolean }?]>;
}

/**
 * Serve one document request through handleRscRendering and settle every
 * background task it scheduled (a MISS's capture included).
 */
/** The partition headers' values, as the handlers render them. */
const Tier = createVar<string | null>();
const Locale = createVar<string | null>();

async function serve(
  router: Router,
  store: MemorySegmentCacheStore,
  path: string,
  init: ServeInit = {},
): Promise<{ response: Response; body: string }> {
  const url = new URL(`http://localhost${path}`);
  const request = new Request(url, {
    headers: { accept: "text/html", ...init.headers },
  });
  const variables: Record<string, unknown> = {};
  // What a middleware would copy from the partition headers for the
  // handlers to render (#976: a handler read of ctx.request.headers under
  // cache() or a capture throws).
  contextSet(variables, Tier, request.headers.get("x-tier"));
  contextSet(variables, Locale, request.headers.get("x-locale"));
  for (const [token, value, options] of init.variables ?? []) {
    contextSet(variables, token as any, value, options);
  }
  const reqCtx = createRequestContext({
    env: {},
    request,
    url,
    variables,
    cacheStore: store,
    cacheProfiles: { default: { ttl: 300 } },
  }) as RequestContext<unknown>;
  const tasks: Promise<unknown>[] = [];
  reqCtx.waitUntil = (task: () => Promise<void>) => {
    tasks.push(Promise.resolve().then(task));
  };
  const ctx = makeCtx(router);
  const response = await runWithRequestContext(reqCtx, async () => {
    const plan = await classifyRequest(request, url, {
      findMatch: (router as unknown as ClassifyRequestDeps).findMatch,
      routerVersion: ctx.version,
      routerId: router.id,
    });
    if (plan.mode !== "full-render") throw new Error(plan.mode);
    setRequestContextParams(plan.route.params, plan.route.routeKey);
    reqCtx._classifiedRoute = plan.route;
    return handleRscRendering(
      ctx,
      request,
      {},
      url,
      false,
      reqCtx._handleStore,
      undefined,
    );
  });
  const body = await readAll(response.body!);
  while (tasks.length > 0) await Promise.allSettled(tasks.splice(0));
  return { response, body };
}

async function storedEntry(
  store: MemorySegmentCacheStore,
  path: string,
  partition?: string,
): Promise<ShellCacheEntry | null> {
  const hit = await store.getShell(
    `localhost${path}:shell${partition === undefined ? "" : `|${encodeURIComponent(partition)}`}`,
  );
  return hit ? hit.entry : null;
}

async function makeRouter(
  routes: Parameters<Router["routes"]>[0],
): Promise<Router> {
  const router = createRouter({} as any);
  router.routes(routes);
  await buildRouterTrieFromUrlpatterns(router);
  return router;
}

/** Every fragment envelope's stored Flight text in a Flight text, in order. */
function fragments(flight: string): string[] {
  const out: string[] = [];
  for (const m of flight.matchAll(
    /"__rangoFragment":1,"f":"((?:[^"\\]|\\.)*)"/g,
  )) {
    out.push(m[1]!);
  }
  return out;
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const runs = { layout: 0, page: 0, stamp: 0, loader: 0, invoked: 0 };

const BakedHandle = createHandle<unknown>(undefined, "test#BakedHandle");

const InvokedLoader = (createLoader as Function)(
  async () => {
    runs.invoked++;
    return { invoked: `invoked-${runs.invoked}` };
  },
  undefined,
  "test#BakedInvokedLoader",
);

const LiveLoader = (createLoader as Function)(
  async () => {
    runs.loader++;
    return { live: `live-${runs.loader}` };
  },
  undefined,
  "test#BakedLiveLoader",
);

async function Resolved({
  promise,
  part,
}: {
  promise: Promise<string>;
  part: string;
}): Promise<React.ReactNode> {
  return <b data-part={part}>{await promise}</b>;
}

/** Uncached and non-deterministic: a new value on every render. */
async function Stamp(): Promise<React.ReactNode> {
  await delay(30);
  runs.stamp++;
  return <i data-part="stamp">{`stamp-${runs.stamp}`}</i>;
}

function BakedLayout(ctx: any): React.ReactNode {
  runs.layout++;
  ctx.use(BakedHandle)({
    label: "crumb",
    nested: delay(60).then(() => `nested-${runs.layout}`),
  });
  return (
    <main>
      <Stamp />
    </main>
  );
}

async function BakedPage(ctx: any): Promise<React.ReactNode> {
  runs.page++;
  const { invoked } = await ctx.use(InvokedLoader);
  const run = runs.page;
  return (
    <section>
      <p data-part="invoked">{invoked}</p>
      <Suspense fallback={<span>promise-fallback</span>}>
        <Resolved
          part="promise"
          promise={delay(80).then(() => `PROMISE-${run}`)}
        />
      </Suspense>
      <p>{await getStamp("page")}</p>
    </section>
  );
}

beforeEach(() => {
  source.generation = 1;
  frozenInputs.length = 0;
  runs.layout = runs.page = runs.stamp = runs.loader = runs.invoked = 0;
});

describe("PPR handlers baked: the capture settles the handler layer and renders from its doc record", () => {
  it("bakes handler promises, async components, nested handler pushes and handler-invoked loaders; the HIT replays the capture's own fragments", async () => {
    const router = await makeRouter(({ layout, path }: any) => [
      layout(BakedLayout, () => [
        path("/baked", BakedPage, { name: "baked", ppr: { ttl: 300 } }),
      ]),
    ]);
    const harness = makeStore();

    const miss = await serve(router, harness.store, "/baked");
    expect(miss.response.headers.get("x-rango-shell")).toBe("MISS");
    const entry = (await storedEntry(harness.store, "/baked"))!;
    expect(entry.docKey).toBe("doc:localhost/baked");
    expect(frozenInputs).toHaveLength(1);
    const frozen = frozenInputs[0]!;

    // Everything the handler layer produced reached the frozen capture input,
    // however slowly it settled: the handler promise (80ms), the uncached
    // async component (30ms), the nested promise in a handler push (60ms),
    // and the handler-invoked loader.
    expect(frozen).toContain("PROMISE-2");
    expect(frozen).toMatch(/stamp-\d/);
    expect(frozen).toContain("nested-2");
    expect(frozen).toContain("invoked-2");

    const before = { ...runs };
    source.generation = 2;
    harness.dropItems();
    harness.itemReads.length = 0;
    const hit = await serve(router, harness.store, "/baked");
    expect(hit.response.headers.get("x-rango-shell")).toBe("HIT");
    // No handler, handler-invoked loader, or server component ran.
    expect(runs).toEqual(before);
    expect(harness.itemReads).toEqual([]);

    // The HIT carries the fragment bytes the capture's frozen input carried.
    const captured = fragments(frozen);
    expect(captured.length).toBeGreaterThan(0);
    expect(fragments(hit.body)).toEqual(captured);
    expect(hit.body.match(/stamp-\d+/)![0]).toBe(frozen.match(/stamp-\d+/)![0]);
    expect(hit.body).toContain("PROMISE-2");
    expect(hit.body).toContain("nested-2");
    expect(hit.body).toContain("page-stamp@g1");
    expect(hit.body).not.toContain("@g2");
  });

  // Red on main (d692487bf): the capture's Flight render and the doc record's
  // encode each ran the component, so the prelude's input showed one value
  // and every HIT (replaying the record) another. The HIT was a hydration
  // mismatch React repaired client-side.
  it("parity: an uncached async server component renders once per capture, and the prelude's input and the HIT carry the same value", async () => {
    let quick = 0;
    async function QuickStamp(): Promise<React.ReactNode> {
      await Promise.resolve();
      quick++;
      return <i data-part="quick">{`quick-${quick}`}</i>;
    }
    const router = await makeRouter(({ layout, path }: any) => [
      layout(
        () => (
          <main>
            <QuickStamp />
          </main>
        ),
        () => [
          path("/quick", () => <p>page</p>, {
            name: "quick",
            ppr: { ttl: 300 },
          }),
        ],
      ),
    ]);
    const harness = makeStore();
    await serve(router, harness.store, "/quick");
    expect(await storedEntry(harness.store, "/quick")).not.toBeNull();
    const frozenValue = frozenInputs[0]!.match(/quick-\d+/)?.[0];

    const hit = await serve(router, harness.store, "/quick");
    expect(hit.response.headers.get("x-rango-shell")).toBe("HIT");
    expect(frozenValue).toBeDefined();
    expect(hit.body.match(/quick-\d+/)?.[0]).toBe(frozenValue);
    // One render for the foreground MISS, one for the capture.
    expect(quick).toBe(2);
  });

  it("a live loader under loading() stays a hole and runs per HIT; the handler's own ctx.use of it bakes", async () => {
    function OwnPage(ctx: any): Promise<React.ReactNode> {
      runs.page++;
      return ctx
        .use(LiveLoader)
        .then(({ live }: { live: string }) => (
          <p data-part="own">{`handler-saw-${live}`}</p>
        ));
    }
    const router = await makeRouter(
      ({ layout, path, loader, loading }: any) => [
        layout(
          () => <main>chrome</main>,
          () => [
            path("/own", OwnPage, { name: "own", ppr: { ttl: 300 } }, () => [
              loader(LiveLoader),
              loading(<p>loading</p>),
            ]),
          ],
        ),
      ],
    );
    const harness = makeStore();
    await serve(router, harness.store, "/own");
    const pageRuns = runs.page;
    const loaderRuns = runs.loader;

    const hit = await serve(router, harness.store, "/own");
    expect(hit.response.headers.get("x-rango-shell")).toBe("HIT");
    expect(runs.page).toBe(pageRuns);
    // The hole's loader ran once for this HIT.
    expect(runs.loader).toBe(loaderRuns + 1);
    // The handler output is the capture's; the hole carries the live value.
    expect(hit.body).toContain(`handler-saw-live-${loaderRuns}`);
    expect(hit.body).toContain(`"live":"live-${loaderRuns + 1}"`);
  });

  it("a HIT tail loader's rendered() sees the handle pushes replayed from the doc record", async () => {
    const TailHandle = createHandle<string, string[]>(
      (values) => values.flat(),
      "test#BakedTailHandle",
    );
    const seen: string[][] = [];
    const TailLoader = (createLoader as Function)(
      async (loaderCtx: any) => {
        await loaderCtx.rendered();
        seen.push(loaderCtx.get(TailHandle));
        return null;
      },
      undefined,
      "test#BakedTailLoader",
    );
    const StreamingSlot = async (handlerCtx: any) => {
      const push = handlerCtx.use(TailHandle);
      await delay(10);
      push("tail-stream");
      return <div>slot</div>;
    };
    const router = await makeRouter(
      ({ layout, loader, loading, parallel, path }: any) => [
        layout(
          () => <main />,
          () => [
            parallel({ "@side": StreamingSlot }, () => [
              loading(<span>loading</span>),
            ]),
            path(
              "/tail",
              () => <div>page</div>,
              { name: "bakedTail", ppr: { ttl: 300 } },
              () => [loader(TailLoader)],
            ),
          ],
        ),
      ],
    );
    const harness = makeStore();
    await serve(router, harness.store, "/tail");
    seen.length = 0;
    const hit = await serve(router, harness.store, "/tail");
    expect(hit.response.headers.get("x-rango-shell")).toBe("HIT");
    await delay(50);
    expect(seen).toEqual([["tail-stream"]]);
  });

  it("handler output slower than ppr.captureTimeout stores no shell and names the cause", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const router = await makeRouter(({ layout, path }: any) => [
        layout(
          () => <main>chrome</main>,
          () => [
            path(
              "/slow",
              () => (
                <Suspense fallback={<span>slow-fallback</span>}>
                  <Resolved
                    part="slow"
                    promise={delay(300).then(() => "SLOW")}
                  />
                </Suspense>
              ),
              { name: "slow", ppr: { ttl: 300, captureTimeout: 50 } },
            ),
          ],
        ),
      ]);
      const harness = makeStore();
      const miss = await serve(router, harness.store, "/slow");
      expect(miss.response.headers.get("x-rango-shell")).toBe("MISS");
      expect(await storedEntry(harness.store, "/slow")).toBeNull();
      const warning = warn.mock.calls
        .map(([message]) => String(message))
        .find((message) => message.includes('"localhost/slow:shell"'));
      expect(warning).toContain("did not settle within ppr.captureTimeout");
    } finally {
      warn.mockRestore();
    }
  });

  it("a handler that awaits past ppr.captureTimeout stores no shell, names the cause, and is not retried", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let layoutRuns = 0;
    try {
      const router = await makeRouter(({ layout, path }: any) => [
        layout(
          async () => {
            layoutRuns++;
            await delay(300);
            return <main>chrome</main>;
          },
          () => [
            path("/slow-handler", () => <p>page</p>, {
              name: "slowHandler",
              ppr: { ttl: 300, captureTimeout: 50 },
            }),
          ],
        ),
      ]);
      const harness = makeStore();
      const miss = await serve(router, harness.store, "/slow-handler");
      expect(miss.response.headers.get("x-rango-shell")).toBe("MISS");
      expect(await storedEntry(harness.store, "/slow-handler")).toBeNull();
      const warning = warn.mock.calls
        .map(([message]) => String(message))
        .find((message) => message.includes('"localhost/slow-handler:shell"'));
      expect(warning).toContain("did not return within ppr.captureTimeout");
      // The foreground and one capture attempt: the in-place retry would
      // start a second match beside the one still running.
      await delay(700);
      expect(layoutRuns).toBe(2);
    } finally {
      warn.mockRestore();
    }
  });

  // An element in a handler push is handler output too: the capture waits
  // for a promise in its props (settleNestedThenables walks element props)
  // before the record's handle encode, whose own 5s timeout would otherwise
  // refuse the capture.
  it("a handler push holding <X data={promise} /> is awaited and baked", async () => {
    const JsxHandle = createHandle<unknown>(undefined, "test#JsxPushHandle");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const router = await makeRouter(({ layout, path }: any) => [
        layout(
          () => <main>chrome</main>,
          () => [
            path(
              "/jsx-push",
              (ctx: any) => {
                ctx.use(JsxHandle)(
                  React.createElement("x-crumb", {
                    data: delay(5_500).then(() => "JSX-PUSH-VALUE"),
                  }),
                );
                return <p>page</p>;
              },
              { name: "jsxPush", ppr: { ttl: 300, captureTimeout: 10_000 } },
            ),
          ],
        ),
      ]);
      const harness = makeStore();
      await serve(router, harness.store, "/jsx-push");
      const entry = await storedEntry(harness.store, "/jsx-push");
      expect(entry).not.toBeNull();
      const record = entry!.snapshot?.find(
        (r) => r.family === "segment" && r.key === entry!.docKey,
      );
      expect(JSON.stringify(record)).toContain("JSX-PUSH-VALUE");
    } finally {
      warn.mockRestore();
    }
  }, 30_000);

  // The push walk does not enter a Map, so a promise in one is not waited
  // for; the record's handle encode then gives up after 5s and stores no
  // handles. A HIT would replay the page without them, so the capture is
  // refused instead.
  it("a handler push hiding a pending promise in a Map refuses the capture", async () => {
    const MapHandle = createHandle<unknown>(undefined, "test#MapPushHandle");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const router = await makeRouter(({ layout, path }: any) => [
        layout(
          () => <main>chrome</main>,
          () => [
            path(
              "/map-push",
              (ctx: any) => {
                ctx.use(MapHandle)({
                  byId: new Map([["a", delay(6_000).then(() => "late")]]),
                });
                return <p>page</p>;
              },
              { name: "mapPush", ppr: { ttl: 300, captureTimeout: 10_000 } },
            ),
          ],
        ),
      ]);
      const harness = makeStore();
      await serve(router, harness.store, "/map-push");
      expect(await storedEntry(harness.store, "/map-push")).toBeNull();
      const warning = warn.mock.calls
        .map(([message]) => String(message))
        .find((message) => message.includes('"localhost/map-push:shell"'));
      expect(warning).toContain("did not finish encoding");
    } finally {
      warn.mockRestore();
    }
  }, 30_000);

  // The doc record's handle encode gives up after 5s. Under a route's own
  // cache() the record used to be written while the pipeline ran, so a
  // handler push slower than that was refused ("did not finish encoding")
  // even inside a longer captureTimeout. It now waits for the pushes like
  // the implicit scope's record does.
  it("a handler push slower than the 5s handle encode bakes under a route's own cache()", async () => {
    const SlowHandle = createHandle<unknown>(undefined, "test#SlowPushHandle");
    const neverStores = Object.assign(new MemorySegmentCacheStore(), {
      set: async () => {},
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const router = await makeRouter(({ layout, path, cache }: any) => [
        layout(
          () => <main>chrome</main>,
          () => [
            // An explicit tier that never stores: the capture's lookup
            // misses it (it would otherwise replay the foreground's entry
            // and never run the handler).
            cache({ ttl: 300, store: neverStores }, () => [
              path(
                "/slow-push",
                (ctx: any) => {
                  ctx.use(SlowHandle)({
                    nested: delay(6_000).then(() => "SLOW-PUSH"),
                  });
                  return <p>page</p>;
                },
                {
                  name: "slowPush",
                  ppr: { ttl: 300, captureTimeout: 10_000 },
                },
              ),
            ]),
          ],
        ),
      ]);
      const harness = makeStore();
      await serve(router, harness.store, "/slow-push");
      const entry = await storedEntry(harness.store, "/slow-push");
      expect(entry).not.toBeNull();
      const record = entry!.snapshot?.find(
        (r) => r.family === "segment" && r.key === entry!.docKey,
      );
      expect(JSON.stringify(record)).toContain("SLOW-PUSH");
      expect(
        warn.mock.calls.some(([message]) =>
          String(message).includes('"localhost/slow-push:shell"'),
        ),
      ).toBe(false);
    } finally {
      warn.mockRestore();
    }
  }, 30_000);
});

describe("PPR handlers baked: no HIT runs a handler", () => {
  const explicitStore = new MemorySegmentCacheStore();
  const variants: Array<{
    name: string;
    options?: PartialCacheOptions;
    keyGenerator?: boolean;
    capture?: Record<string, string>;
    hit?: Record<string, string>;
    beforeHit?: () => Promise<void> | void;
  }> = [
    {
      name: "a route cache() whose explicit tier lost its record",
      options: { ttl: 300, store: explicitStore },
      beforeHit: () => explicitStore.clear(),
    },
    {
      name: "a route cache() key(): a HIT in the same partition",
      options: {
        ttl: 300,
        key: (ctx) => `variant:${ctx.request.headers.get("x-variant")}`,
      },
      capture: { "x-variant": "a" },
      hit: { "x-variant": "a" },
    },
    {
      name: "a store keyGenerator: a HIT in the same partition",
      keyGenerator: true,
      capture: { "x-segment": "a" },
      hit: { "x-segment": "a" },
    },
  ];

  it.each(variants)(
    "$name",
    async ({ options, keyGenerator, capture, hit, beforeHit }) => {
      const router = await makeRouter(({ layout, path, cache }: any) => [
        layout(BakedLayout, () =>
          options
            ? [
                cache(options, () => [
                  path("/v", BakedPage, { name: "v", ppr: { ttl: 300 } }),
                ]),
              ]
            : [path("/v", BakedPage, { name: "v", ppr: { ttl: 300 } })],
        ),
      ]);
      const harness = makeStore();
      if (keyGenerator) {
        Object.assign(harness.store, {
          keyGenerator: (ctx: RequestContext, defaultKey: string) =>
            `${defaultKey}|${ctx.request.headers.get("x-segment") ?? ""}`,
        });
      }
      await serve(router, harness.store, "/v", { headers: capture });
      await beforeHit?.();
      const before = { ...runs };
      source.generation = 2;
      harness.dropItems();
      harness.itemReads.length = 0;
      const served = await serve(router, harness.store, "/v", {
        headers: hit,
      });
      expect(served.response.headers.get("x-rango-shell")).toBe("HIT");
      expect(runs).toEqual(before);
      expect(harness.itemReads).toEqual([]);
      expect(served.body).toContain("page-stamp@g1");
      expect(served.body).not.toContain("@g2");
    },
  );

  it("cache(false) on a ppr route renders axis 1 and never captures", async () => {
    const router = await makeRouter(({ layout, path, cache }: any) => [
      layout(BakedLayout, () => [
        cache(false, () => [
          path("/optout", BakedPage, { name: "optout", ppr: { ttl: 300 } }),
        ]),
      ]),
    ]);
    const harness = makeStore();
    for (let i = 0; i < 2; i++) {
      const served = await serve(router, harness.store, "/optout");
      expect(served.response.headers.get("x-rango-shell")).toBeNull();
      expect(served.body).toBe("<html><body>AXIS-1</body></html>");
    }
    expect(await storedEntry(harness.store, "/optout")).toBeNull();
    expect(frozenInputs).toHaveLength(0);
  });
});

/**
 * A route whose cache() record is partitioned by the request (its `key()`,
 * or the store's `keyGenerator`) partitions its shell the same way: each
 * partition captures and serves its own, and nothing crosses partitions.
 * The content renders middleware's copy of the request header (a handler read
 * of ctx.request.headers refuses the capture, #976); the key() and the
 * keyGenerator read the header, and the partition key is what keeps the
 * content per visitor group.
 */
describe("PPR handlers baked: request-partitioned shells", () => {
  function TierLayout(ctx: any): React.ReactNode {
    cacheTag("tiered");
    return <main>{`tier-${ctx.get(Tier)}-layout`}</main>;
  }
  function TierPage(ctx: any): React.ReactNode {
    return <p>{`tier-${ctx.get(Tier)}-page`}</p>;
  }

  async function tieredRouter(keyCalls: string[]): Promise<Router> {
    return makeRouter(({ layout, path, cache }: any) => [
      cache(
        {
          ttl: 300,
          key: (ctx: RequestContext) => {
            const tier = ctx.request.headers.get("x-tier") ?? "none";
            keyCalls.push(tier);
            return `tier:${tier}`;
          },
        },
        () => [
          layout(TierLayout, () => [
            path("/tiered", TierPage, { name: "tiered", ppr: { ttl: 300 } }),
          ]),
        ],
      ),
    ]);
  }

  it("route cache({ key }): gold captures, silver MISSes and captures its own, each HITs its own", async () => {
    const keyCalls: string[] = [];
    const router = await tieredRouter(keyCalls);
    const harness = makeStore();
    const gold = { headers: { "x-tier": "gold" } };
    const silver = { headers: { "x-tier": "silver" } };

    const goldMiss = await serve(router, harness.store, "/tiered", gold);
    expect(goldMiss.response.headers.get("x-rango-shell")).toBe("MISS");
    expect(
      await storedEntry(harness.store, "/tiered", "key:tier%3Agold"),
    ).not.toBe(null);
    // No unpartitioned shell exists for a partitioned route.
    expect(await storedEntry(harness.store, "/tiered")).toBeNull();

    const silverMiss = await serve(router, harness.store, "/tiered", silver);
    expect(silverMiss.response.headers.get("x-rango-shell")).toBe("MISS");

    keyCalls.length = 0;
    const goldHit = await serve(router, harness.store, "/tiered", gold);
    // key() ran once for the request: the shell key and nothing else (a HIT
    // replays its record and never consults the route scope).
    expect(keyCalls).toEqual(["gold"]);
    const silverHit = await serve(router, harness.store, "/tiered", silver);
    for (const [hit, own, other] of [
      [goldHit, "gold", "silver"],
      [silverHit, "silver", "gold"],
    ] as const) {
      expect(hit.response.headers.get("x-rango-shell")).toBe("HIT");
      // The tail replays this partition's record: its own layout and page.
      expect(hit.body).toContain(`tier-${own}-layout`);
      expect(hit.body).toContain(`tier-${own}-page`);
      expect(hit.body).not.toContain(`tier-${other}`);
    }
    // Each capture's frozen Flight input (what its prelude renders) is its
    // own partition's too.
    expect(frozenInputs).toHaveLength(2);
    expect(frozenInputs[0]).toContain("tier-gold-page");
    expect(frozenInputs[0]).not.toContain("tier-silver");
    expect(frozenInputs[1]).toContain("tier-silver-page");
    expect(frozenInputs[1]).not.toContain("tier-gold");

    // updateTag() of a tag every partition carries evicts every partition.
    await harness.store.invalidateTags(["tiered"]);
    expect(
      await storedEntry(harness.store, "/tiered", "key:tier%3Agold"),
    ).toBeNull();
    expect(
      await storedEntry(harness.store, "/tiered", "key:tier%3Asilver"),
    ).toBeNull();
  });

  it("key() runs once per request: the shell key, the record lookup and the capture share it", async () => {
    const keyCalls: string[] = [];
    const router = await tieredRouter(keyCalls);
    const harness = makeStore();
    const lookups: Array<Promise<unknown>> = [];
    const serving = serve(router, harness.store, "/tiered", {
      headers: { "x-tier": "gold" },
    });
    lookups.push(serving);
    await Promise.all(lookups);
    // The MISS: one call shared by the shell key, the foreground's record
    // lookup and write, and the capture (its context inherits the request's
    // resolved keys).
    expect(keyCalls).toEqual(["gold"]);
  });

  it("a key() that throws serves no shell and never another partition's", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let fail = false;
      const router = await makeRouter(({ layout, path, cache }: any) => [
        cache(
          {
            ttl: 300,
            key: (ctx: RequestContext) => {
              if (fail) throw new Error("no tier");
              return `tier:${ctx.request.headers.get("x-tier")}`;
            },
          },
          () => [
            layout(TierLayout, () => [
              path("/tiered", TierPage, { name: "tiered", ppr: { ttl: 300 } }),
            ]),
          ],
        ),
      ]);
      const harness = makeStore();
      await serve(router, harness.store, "/tiered", {
        headers: { "x-tier": "gold" },
      });
      expect(
        await storedEntry(harness.store, "/tiered", "key:tier%3Agold"),
      ).not.toBeNull();

      fail = true;
      const failed = await serve(router, harness.store, "/tiered", {
        headers: { "x-tier": "gold" },
      });
      // Axis 1: no shell header, no shell served, no capture.
      expect(failed.response.headers.get("x-rango-shell")).toBeNull();
      expect(failed.body).toBe("<html><body>AXIS-1</body></html>");
    } finally {
      errors.mockRestore();
    }
  });

  it("a store keyGenerator gives each locale its own shell", async () => {
    const router = await makeRouter(({ layout, path }: any) => [
      layout(
        (ctx: any) => <main>{`locale-${ctx.get(Locale)}`}</main>,
        () => [
          path("/localized", () => <p>page</p>, {
            name: "localized",
            ppr: { ttl: 300 },
          }),
        ],
      ),
    ]);
    const harness = makeStore();
    Object.assign(harness.store, {
      keyGenerator: (ctx: RequestContext, defaultKey: string) =>
        `${defaultKey}|${ctx.request.headers.get("x-locale")}`,
    });
    const en = { headers: { "x-locale": "en" } };
    const de = { headers: { "x-locale": "de" } };
    await serve(router, harness.store, "/localized", en);
    await serve(router, harness.store, "/localized", de);

    const enHit = await serve(router, harness.store, "/localized", en);
    const deHit = await serve(router, harness.store, "/localized", de);
    expect(enHit.response.headers.get("x-rango-shell")).toBe("HIT");
    expect(deHit.response.headers.get("x-rango-shell")).toBe("HIT");
    expect(enHit.body).toContain("locale-en");
    expect(enHit.body).not.toContain("locale-de");
    expect(deHit.body).toContain("locale-de");
    expect(deHit.body).not.toContain("locale-en");
    expect(
      await storedEntry(
        harness.store,
        "/localized",
        "doc:localhost/localized|en",
      ),
    ).not.toBeNull();
  });
});

/**
 * The capture now waits for handler promises, async server components and
 * handle pushes, so a request-scoped read inside them happens during the
 * capture. Each one must refuse it: the value would bake into a shell shared
 * per host+URL.
 */
describe("PPR handlers baked: request-scoped reads inside what the capture waits for refuse it", () => {
  const Session = createVar<string>({ cache: false });

  async function expectRefused(
    route: (helpers: any) => unknown[],
    path: string,
    fnName: string,
    init: ServeInit = {},
  ): Promise<void> {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const router = await makeRouter(route as any);
      const harness = makeStore();
      const miss = await serve(router, harness.store, path, init);
      // The foreground render is unaffected: it serves the real visitor.
      expect(miss.response.headers.get("x-rango-shell")).toBe("MISS");
      expect(miss.response.status).toBe(200);
      // Nothing was stored, and the refusal names the read.
      expect(await storedEntry(harness.store, path)).toBeNull();
      const warning = warn.mock.calls
        .map(([message]) => String(message))
        .find((message) => message.includes(`"localhost${path}:shell"`));
      expect(warning).toContain("was refused");
      expect(warning).toContain(fnName);
    } finally {
      warn.mockRestore();
    }
  }

  const COOKIE = { cookie: "session=user-a" };

  it("cookies() inside a handler promise under Suspense", async () => {
    await expectRefused(
      ({ path }: any) => [
        path(
          "/p1",
          () => (
            <Suspense fallback={<span>f</span>}>
              <Resolved
                part="who"
                promise={delay(5).then(
                  () => cookies().get("session")?.value ?? "anon",
                )}
              />
            </Suspense>
          ),
          { name: "p1", ppr: { ttl: 300 } },
        ),
      ],
      "/p1",
      "cookies()",
      { headers: COOKIE },
    );
  });

  it("cookies() inside a handler promise that catches the guard's throw", async () => {
    await expectRefused(
      ({ path }: any) => [
        path(
          "/p2",
          () => (
            <Resolved
              part="who"
              promise={delay(5).then(() => {
                try {
                  return cookies().get("session")?.value ?? "anon";
                } catch {
                  return "anon";
                }
              })}
            />
          ),
          { name: "p2", ppr: { ttl: 300 } },
        ),
      ],
      "/p2",
      "cookies()",
      { headers: COOKIE },
    );
  });

  it("headers() inside an async server component with no Suspense above it", async () => {
    async function WhoAmI(): Promise<React.ReactNode> {
      await delay(5);
      return <b>{headers().get("x-user") ?? "anon"}</b>;
    }
    await expectRefused(
      ({ path }: any) => [
        path("/p3", () => <WhoAmI />, { name: "p3", ppr: { ttl: 300 } }),
      ],
      "/p3",
      "headers()",
      { headers: { "x-user": "user-a" } },
    );
  });

  it("ctx.get of a { cache: false } variable inside a nested handle push", async () => {
    await expectRefused(
      ({ path }: any) => [
        path(
          "/p4",
          (ctx: any) => {
            ctx.use(BakedHandle)({
              who: delay(5).then(() => ctx.get(Session)),
            });
            return <p>page</p>;
          },
          { name: "p4", ppr: { ttl: 300 } },
        ),
      ],
      "/p4",
      "ctx.get()",
      { variables: [[Session, "user-a"]] },
    );
  });

  it("getRequestContext().get of a { cache: false } variable inside an async server component", async () => {
    async function Who(): Promise<React.ReactNode> {
      await delay(5);
      return <b>{getRequestContext().get(Session)}</b>;
    }
    await expectRefused(
      ({ path }: any) => [
        path("/p5", () => <Who />, { name: "p5", ppr: { ttl: 300 } }),
      ],
      "/p5",
      "ctx.get()",
      { variables: [[Session, "user-a"]] },
    );
  });

  it("ctx.dynamic() inside a handler promise", async () => {
    // Opts out only on the second run (the capture), as a handler would
    // after an await on data that changed: the foreground MISS stays
    // capturable, and the capture must not bake the dynamic render.
    let calls = 0;
    await expectRefused(
      ({ path }: any) => [
        path(
          "/p6",
          (ctx: any) => (
            <Suspense fallback={<span>f</span>}>
              <Resolved
                part="dyn"
                promise={delay(5).then(() => {
                  if (++calls === 2) ctx.dynamic();
                  return "dynamic";
                })}
              />
            </Suspense>
          ),
          { name: "p6", ppr: { ttl: 300 } },
        ),
      ],
      "/p6",
      "ctx.dynamic()",
    );
  });

  it("cookies() in a loader the handler awaits (handler-invoked loaders are baked too)", async () => {
    const IdentityLoader = (createLoader as Function)(
      async () => ({ who: cookies().get("session")?.value ?? "anon" }),
      undefined,
      "test#BakedIdentityLoader",
    );
    await expectRefused(
      ({ path }: any) => [
        path(
          "/p7",
          async (ctx: any) => {
            const { who } = await ctx.use(IdentityLoader);
            return <p>{who}</p>;
          },
          { name: "p7", ppr: { ttl: 300 } },
        ),
      ],
      "/p7",
      "cookies()",
      { headers: COOKIE },
    );
  });

  // Not a guarded read: a normal variable is shell material like any other
  // handler input, shared per host+URL. The migration note says so.
  it("ctx.get of a normal variable bakes the capturing request's value", async () => {
    const Tenant = createVar<string>();
    const router = await makeRouter(({ path }: any) => [
      path(
        "/p8",
        (ctx: any) => (
          <Resolved
            part="tenant"
            promise={delay(5).then(() => `tenant-${ctx.get(Tenant)}`)}
          />
        ),
        { name: "p8", ppr: { ttl: 300 } },
      ),
    ]);
    const harness = makeStore();
    await serve(router, harness.store, "/p8", { variables: [[Tenant, "a"]] });
    const hit = await serve(router, harness.store, "/p8", {
      variables: [[Tenant, "b"]],
    });
    expect(hit.response.headers.get("x-rango-shell")).toBe("HIT");
    expect(hit.body).toContain("tenant-a");
    expect(hit.body).not.toContain("tenant-b");
  });
});
