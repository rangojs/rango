import { describe, it, expect, vi, beforeEach } from "vitest";

// PPR serving is INTEGRAL to the render pipeline: handleRscRendering itself reads
// the matched route's `ppr` path option (off the classified route snapshot),
// consults the app-level store's shell family, and either commits the composed
// HIT response (prelude flushed first, live tail resumed behind it) or serves
// axis 1 and schedules a background capture. Mock ONLY the capture dispatch seam
// (scheduleShellCapture) so these tests assert the serve/schedule decisions
// against the REAL shell-serve config/key/store logic and a REAL memory store.
vi.mock("../shell-capture.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shell-capture.js")>();
  return {
    ...actual,
    scheduleShellCapture: vi.fn(),
  };
});

// The replay gate's prerender-store probe (prerenderEntryExists in
// cache-lookup.ts) consults the real prerender store singleton; stub the
// store factory so tests control artifact existence per test. Default: no
// baked artifact (get resolves null).
const prerenderStoreGetMock = vi.hoisted(() =>
  vi.fn(async (): Promise<unknown> => null),
);
vi.mock("../../prerender/store.js", () => ({
  createPrerenderStore: () => ({ get: prerenderStoreGetMock }),
}));

import React from "react";
import { createRouter } from "../../router.js";
import { createLoader } from "../../loader.rsc.js";
import { createHandle } from "../../handle.js";
import { buildRouterTrieFromUrlpatterns } from "../manifest-init.js";
import { handleRscRendering } from "../rsc-rendering.js";
import { scheduleShellCapture } from "../shell-capture.js";
import { MemorySegmentCacheStore } from "../../cache/memory-segment-store.js";
import type { CachedEntryData, ShellCacheEntry } from "../../cache/types.js";
import {
  createRequestContext,
  runWithRequestContext,
  getRequestContext,
  type RequestContext,
} from "../../server/request-context.js";
import type { ShellSnapshotRecord } from "../../cache/types.js";
import { contextSet } from "../../context-var.js";
import { nonce as nonceToken } from "../nonce.js";
import type { HandlerContext } from "../handler-context.js";
import type { RscPayload, SSRModule } from "../types.js";
import type { PartialPrerenderProps } from "../../urls/pattern-types.js";
import { runWithRequestTransaction } from "../../router/request-identity.js";
import {
  getDevelopmentDiagnosticHub,
  resetDevelopmentDiagnosticHub,
} from "../../router/diagnostics/hub.js";

const scheduleMock = vi.mocked(scheduleShellCapture);

const PRELUDE_HTML = "<html><body>SHELL-PRELUDE</body></html>";

function emptyMatchResult() {
  return {
    segments: [],
    matched: [],
    diff: [],
    resolvedIds: [],
    params: {},
    routeName: "home",
  };
}

function shellEntry(overrides: Partial<ShellCacheEntry> = {}): ShellCacheEntry {
  return {
    prelude: btoa(PRELUDE_HTML),
    postponed: JSON.stringify({ hole: 1 }),
    reactVersion: React.version,
    // Matches makeCtx's ctx.version — the build half of the validity gate.
    buildVersion: "v-test",
    createdAt: Date.now(),
    ...overrides,
  };
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
}

async function readAll(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

function makeCtx(ssrModule: SSRModule, streamMode: string) {
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
      match: vi.fn(async () => ({
        redirect: undefined,
        ...emptyMatchResult(),
      })),
      matchPartial: vi.fn(async () => emptyMatchResult()),
    },
    callOnError: vi.fn(),
    renderToReadableStream: (payload: RscPayload) => {
      void payload;
      return new ReadableStream();
    },
    loadSSRModule: vi.fn(async () => ssrModule),
    resolveStreamMode: vi.fn(async () => streamMode),
  } as unknown as HandlerContext<unknown>;
  return { ctx };
}

interface RunOpts {
  ssrModule: SSRModule;
  streamMode?: string;
  nonce?: string;
  /** The matched page route's ppr path option (undefined = not declared). */
  ppr?: boolean | PartialPrerenderProps;
  /** Store on reqCtx._cacheStore. Defaults to a fresh MemorySegmentCacheStore. */
  store?: unknown;
  url?: string;
  partial?: boolean;
  /** Request method (default GET). The replay gate bypasses non-GET. */
  method?: string;
  /**
   * Partial requests carry a navigation-context header by default (matching a
   * real client navigation — the replay gate bypasses without one). Set false
   * to model a context-less probe (curl, synthetic monitor).
   */
  navContext?: false;
  /** Fragment capability header is present by default on client partials. */
  fragmentCapability?: false;
  /** Extra request headers (e.g. X-RSC-HMR). */
  headers?: Record<string, string>;
  shell?: ShellCacheEntry;
  matchPartial?: () => ReturnType<
    HandlerContext<unknown>["router"]["matchPartial"]
  >;
  arm?: (reqCtx: RequestContext<unknown>) => void;
  router?: HandlerContext<unknown>["router"];
  diagnostics?: boolean;
}

async function run(opts: RunOpts): Promise<{
  response: Response;
  reqCtx: RequestContext<unknown>;
  ctx: HandlerContext<unknown>;
  store: MemorySegmentCacheStore;
}> {
  const { ctx } = makeCtx(opts.ssrModule, opts.streamMode ?? "stream");
  if (opts.router) (ctx as any).router = opts.router;
  if (opts.matchPartial) {
    (ctx.router.matchPartial as ReturnType<typeof vi.fn>).mockImplementation(
      opts.matchPartial,
    );
  }
  const request = new Request(
    opts.url ??
      (opts.partial
        ? "http://localhost/p?_rsc_partial=true&_rsc_segments=L0"
        : "http://localhost/p"),
    {
      method: opts.method ?? "GET",
      headers: {
        accept: opts.partial ? "text/x-component" : "text/html",
        ...(opts.partial && opts.navContext !== false
          ? { "X-RSC-Router-Client-Path": "/from" }
          : {}),
        ...(opts.partial && opts.fragmentCapability !== false
          ? { "X-Rango-Fragment-Passthrough": "1" }
          : {}),
        ...opts.headers,
      },
    },
  );
  const url = new URL(request.url);
  const store =
    (opts.store as MemorySegmentCacheStore | undefined) ??
    new MemorySegmentCacheStore();
  const reqCtx = createRequestContext({
    env: {},
    request,
    url,
    variables: {},
  }) as RequestContext<unknown>;
  reqCtx._cacheStore = store as any;
  if (opts.shell) {
    await store.putShell(KEY, opts.shell, 300);
  }
  // The classified route snapshot the RSC handler stores before dispatching the
  // render; the integrated PPR path reads the matched entry's ppr option off it.
  (reqCtx as any)._classifiedRoute = {
    manifestEntry: {
      type: "route",
      // Real manifest entries terminate their parent chain with null; the
      // replay gate walks it (classifiedRouteCacheScope -> traverseBack).
      parent: null,
      ...(opts.ppr !== undefined ? { ppr: opts.ppr } : {}),
    },
  };
  opts.arm?.(reqCtx);

  const render = () =>
    handleRscRendering(
      ctx,
      request,
      {},
      url,
      opts.partial ?? false,
      reqCtx._handleStore,
      opts.nonce,
    );
  const response = await runWithRequestContext(reqCtx, () =>
    opts.diagnostics
      ? runWithRequestTransaction(request, "request", render, {
          routerId: "test-router",
          diagnosticsEnabled: true,
        })
      : render(),
  );
  return { response, reqCtx, ctx, store };
}

function fullSsrModule() {
  return {
    renderHTML: vi.fn(async () => streamOf("<html>axis1</html>")),
    resumeShellHTML: vi.fn(async () => streamOf("RESUMED-HOLE")),
    captureShellHTML: vi.fn(async () => ({
      prelude: new Uint8Array(),
      postponed: null,
    })),
  } as unknown as SSRModule;
}

const KEY = "localhost/p:shell";
const NAVIGATION_KEY = `${KEY}:navigation`;

beforeEach(() => {
  scheduleMock.mockClear();
  resetDevelopmentDiagnosticHub();
});

describe("handleRscRendering — integrated PPR serve: MISS", () => {
  it("ppr: true — serves axis 1 tagged MISS and schedules a capture with the DEFAULT policy (ttl 300)", async () => {
    const ssrModule = fullSsrModule();
    const { response, store } = await run({ ssrModule, ppr: true });

    expect(ssrModule.renderHTML).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-rango-shell")).toBe("MISS");
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    // (ctx, request, env, url, reqCtx, ssrModule, descriptor)
    const descriptor = scheduleMock.mock.calls[0]![6] as any;
    expect(descriptor.key).toBe(KEY);
    expect(descriptor.ttl).toBe(300); // DEFAULT_PPR_TTL_SECONDS
    expect(descriptor.swr).toBeUndefined();
    expect(descriptor.tags).toBeUndefined();
    expect(descriptor.store).toBe(store);
  });

  it("ppr: { ttl, swr, tags } — the route's PartialPrerenderProps flow onto the capture descriptor", async () => {
    const { response } = await run({
      ssrModule: fullSsrModule(),
      ppr: { ttl: 600, swr: 120, tags: ["op:x"] },
    });
    expect(response.headers.get("x-rango-shell")).toBe("MISS");
    const descriptor = scheduleMock.mock.calls[0]![6] as any;
    expect(descriptor.ttl).toBe(600);
    expect(descriptor.swr).toBe(120);
    expect(descriptor.tags).toEqual(["op:x"]);
    // No captureTimeout declared: the descriptor carries none, so the capture
    // uses its own default (SHELL_CAPTURE_MAX_WAIT_MS) — single owner.
    expect(descriptor.captureTimeout).toBeUndefined();
  });

  it("ppr: { captureTimeout } — the settle budget flows onto the capture descriptor (issue #715)", async () => {
    const { response } = await run({
      ssrModule: fullSsrModule(),
      ppr: { ttl: 600, captureTimeout: 12_000 },
    });
    expect(response.headers.get("x-rango-shell")).toBe("MISS");
    const descriptor = scheduleMock.mock.calls[0]![6] as any;
    expect(descriptor.captureTimeout).toBe(12_000);
  });

  it("ppr: { captureTimeout: <invalid> } — normalized away so the capture default applies", async () => {
    const { response } = await run({
      ssrModule: fullSsrModule(),
      ppr: { ttl: 600, captureTimeout: Number.NaN },
    });
    expect(response.headers.get("x-rango-shell")).toBe("MISS");
    const descriptor = scheduleMock.mock.calls[0]![6] as any;
    expect(descriptor.captureTimeout).toBeUndefined();
  });

  it("treats a reactVersion-mismatched entry as a MISS and schedules a recapture", async () => {
    const store = new MemorySegmentCacheStore();
    await store.putShell(KEY, shellEntry({ reactVersion: "0.0.0-stale" }), 300);
    const ssrModule = fullSsrModule();
    const { response } = await run({ ssrModule, ppr: true, store });

    expect(response.headers.get("x-rango-shell")).toBe("MISS");
    expect(ssrModule.renderHTML).toHaveBeenCalledTimes(1);
    expect(ssrModule.resumeShellHTML).not.toHaveBeenCalled();
    expect(scheduleMock).toHaveBeenCalledTimes(1);
  });

  // A persistent shared store (KV/runtime-cache) survives deploys; an app-code
  // change that keeps the same React version would otherwise resume a stale
  // build's postponed blob against the new build's tree — a tree mismatch AFTER
  // the 200 + prelude committed. buildVersion is the second validity gate.
  it("treats a buildVersion-mismatched entry as a MISS and schedules a recapture stamped with the running build", async () => {
    const store = new MemorySegmentCacheStore();
    await store.putShell(KEY, shellEntry({ buildVersion: "stale-build" }), 300);
    const ssrModule = fullSsrModule();
    const { response } = await run({ ssrModule, ppr: true, store });

    expect(response.headers.get("x-rango-shell")).toBe("MISS");
    expect(ssrModule.renderHTML).toHaveBeenCalledTimes(1);
    expect(ssrModule.resumeShellHTML).not.toHaveBeenCalled();
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    // The recapture descriptor carries the RUNNING build's version, so the
    // overwriting entry passes the gate next time.
    const descriptor = scheduleMock.mock.calls[0]![6] as any;
    expect(descriptor.buildVersion).toBe("v-test");
  });

  it("treats an entry with NO buildVersion (stored pre-field) as a MISS", async () => {
    const store = new MemorySegmentCacheStore();
    await store.putShell(KEY, shellEntry({ buildVersion: undefined }), 300);
    const ssrModule = fullSsrModule();
    const { response } = await run({ ssrModule, ppr: true, store });

    expect(response.headers.get("x-rango-shell")).toBe("MISS");
    expect(ssrModule.resumeShellHTML).not.toHaveBeenCalled();
    expect(scheduleMock).toHaveBeenCalledTimes(1);
  });

  it("never serves a navigation-only capture as an HTML document", async () => {
    const store = new MemorySegmentCacheStore();
    await store.putShell(
      KEY,
      shellEntry({ navigationOnly: true, snapshot: [] }),
      300,
    );
    const ssrModule = fullSsrModule();

    const { response } = await run({ ssrModule, ppr: true, store });

    expect(response.headers.get("x-rango-shell")).toBe("MISS");
    expect(ssrModule.renderHTML).toHaveBeenCalledTimes(1);
    expect(ssrModule.resumeShellHTML).not.toHaveBeenCalled();
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(scheduleMock.mock.calls[0]![6]).not.toMatchObject({
      navigationOnly: true,
    });
  });

  // Corrupt stored payloads previously exploded AFTER the commit point: an
  // unparseable postponed blob threw inside resumeShellHTML with the 200 + full
  // static prelude already flushed — a visually complete page that never
  // hydrates, re-served on every request until TTL. The integrity gate turns
  // both corruption shapes into a plain MISS the recapture overwrites.
  it("treats an entry whose postponed blob is not parseable JSON as a MISS (axis 1 served, recapture scheduled)", async () => {
    const store = new MemorySegmentCacheStore();
    await store.putShell(KEY, shellEntry({ postponed: '{"truncated' }), 300);
    const ssrModule = fullSsrModule();
    const { response } = await run({ ssrModule, ppr: true, store });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-rango-shell")).toBe("MISS");
    expect(ssrModule.renderHTML).toHaveBeenCalledTimes(1);
    expect(ssrModule.resumeShellHTML).not.toHaveBeenCalled();
    expect(scheduleMock).toHaveBeenCalledTimes(1);
  });

  it("treats an entry whose prelude is not decodable base64 as a MISS", async () => {
    const store = new MemorySegmentCacheStore();
    await store.putShell(KEY, shellEntry({ prelude: "%%%not-base64%%%" }), 300);
    const ssrModule = fullSsrModule();
    const { response } = await run({ ssrModule, ppr: true, store });

    expect(response.headers.get("x-rango-shell")).toBe("MISS");
    expect(ssrModule.resumeShellHTML).not.toHaveBeenCalled();
    expect(scheduleMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT schedule when the axis-1 response is not a 200 HTML document, but still tags MISS", async () => {
    const ssrModule = fullSsrModule();
    const { response } = await run({
      ssrModule,
      ppr: true,
      arm: (reqCtx) => {
        // notFound()/error path: ctx.res.status wins in createResponseWithMergedHeaders.
        reqCtx.setStatus(404);
      },
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("x-rango-shell")).toBe("MISS");
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it("ctx.dynamic() during axis-1 render suppresses the follow-up shell capture", async () => {
    const ssrModule = fullSsrModule();
    (ssrModule.renderHTML as any).mockImplementation(async () => {
      getRequestContext().dynamic();
      return streamOf("<html>axis1</html>");
    });

    const { response } = await run({ ssrModule, ppr: true, diagnostics: true });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-rango-shell")).toBeNull();
    expect(ssrModule.renderHTML).toHaveBeenCalledTimes(1);
    expect(scheduleMock).not.toHaveBeenCalled();
    expect(
      getDevelopmentDiagnosticHub()!
        .listTraces()[0]!
        .events.find((event) => event.type === "ppr.document")?.data,
    ).toMatchObject({ outcome: "bypass", reason: "dynamic" });
  });
});

describe("handleRscRendering — integrated PPR serve: HIT", () => {
  it("commits the composed response: prelude bytes FIRST, resumed tail behind, x-rango-shell: HIT", async () => {
    const store = new MemorySegmentCacheStore();
    await store.putShell(KEY, shellEntry(), 300, 30);
    const ssrModule = fullSsrModule();

    const { response, ctx } = await run({ ssrModule, ppr: true, store });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-rango-shell")).toBe("HIT");
    expect(response.headers.get("content-type")).toBe(
      "text/html;charset=utf-8",
    );
    // Composition: prelude bytes precede the resumed tail in one body.
    const text = await readAll(response.body!);
    expect(text).toBe(`${PRELUDE_HTML}RESUMED-HOLE`);
    // The tail ran the live pipeline: match + resume, never the axis-1 fizz.
    expect((ctx.router as any).match).toHaveBeenCalledTimes(1);
    expect(ssrModule.resumeShellHTML).toHaveBeenCalledTimes(1);
    const [, opts] = (ssrModule.resumeShellHTML as any).mock.calls[0];
    expect(opts.postponed).toBe(JSON.stringify({ hole: 1 }));
    expect(ssrModule.renderHTML).not.toHaveBeenCalled();
    // Fresh hit: no recapture.
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it.each([
    ["seeded", [{ family: "item", key: "seed", value: { value: "x" } }]],
    ["fragment-only", undefined],
  ] as const)(
    "%s tail gives ctx.rendered() the streamed handle snapshot from its own render",
    async (_label, snapshot) => {
      const TailHandle = createHandle<string, string[]>(
        (values) => values.flat(),
        "test#ShellHitTailHandle",
      );
      const seen: string[][] = [];
      const TailLoader = (createLoader as Function)(
        async (loaderCtx: any) => {
          await loaderCtx.rendered();
          seen.push(loaderCtx.use(TailHandle));
          return null;
        },
        undefined,
        "test#ShellHitTailLoader",
      );
      const StreamingSlot = async (handlerCtx: any) => {
        const push = handlerCtx.use(TailHandle);
        await new Promise((resolve) => setTimeout(resolve, 10));
        push("tail-stream");
        return React.createElement("div", null, "slot");
      };
      const router = createRouter({} as any);
      router.routes(({ layout, loader, loading, parallel, path }: any) => [
        layout(React.createElement("main"), () => [
          parallel({ "@side": StreamingSlot }, () => [
            loading(React.createElement("span", null, "loading")),
          ]),
          path(
            "/p",
            () => React.createElement("div", null, "page"),
            { name: "shellHitTail" },
            () => [loader(TailLoader)],
          ),
        ]),
      ]);
      await buildRouterTrieFromUrlpatterns(router);

      const ssrModule = fullSsrModule();
      const { response } = await run({
        ssrModule,
        ppr: true,
        router: router as unknown as HandlerContext<unknown>["router"],
        shell: shellEntry({
          snapshot: snapshot as ShellSnapshotRecord[] | undefined,
        }),
      });

      await readAll(response.body!);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(seen).toEqual([["tail-stream"]]);
    },
  );

  it("ctx.dynamic() during the HIT tail render does NOT un-commit the shell (stays HIT, no recapture)", async () => {
    // The commit already happened by the time the tail renders, so a dynamic()
    // call there is a no-op: x-rango-shell stays HIT and nothing reschedules a
    // capture. Pins the handler seat's "only affects a MISS" half of the
    // dynamic() contract (types/handler-context.ts) — the mirror of the MISS
    // case (dynamic() during axis-1 render suppresses the follow-up capture).
    const store = new MemorySegmentCacheStore();
    await store.putShell(KEY, shellEntry(), 300, 30);
    const ssrModule = fullSsrModule();
    (ssrModule.resumeShellHTML as any).mockImplementation(async () => {
      getRequestContext().dynamic();
      return streamOf("RESUMED-HOLE");
    });

    const { response } = await run({ ssrModule, ppr: true, store });

    expect(response.headers.get("x-rango-shell")).toBe("HIT");
    // Draining runs the tail (where dynamic() fired) behind the committed prelude.
    const text = await readAll(response.body!);
    expect(text).toBe(`${PRELUDE_HTML}RESUMED-HOLE`);
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  // Self-heal on a failed tail: the pre-commit gates cannot catch a
  // parseable-but-mismatched postponed blob or a hard render error above the
  // holes — those throw after the 200 + prelude flushed. Without the recapture
  // the same entry re-fails every request until it ages out (nothing else
  // evicts it).
  it("schedules a recapture when the tail fails after the prelude committed", async () => {
    const store = new MemorySegmentCacheStore();
    await store.putShell(KEY, shellEntry(), 300, 30);
    const ssrModule = fullSsrModule();
    (ssrModule.resumeShellHTML as any).mockRejectedValue(
      new Error("resume tree mismatch"),
    );

    const { response } = await run({ ssrModule, ppr: true, store });
    // The commit already happened: HIT headers, 200.
    expect(response.headers.get("x-rango-shell")).toBe("HIT");
    // Draining the body surfaces the tail failure as a stream error...
    await expect(readAll(response.body!)).rejects.toThrow(
      "resume tree mismatch",
    );
    // ...and the catch scheduled the healing recapture for the same key.
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    const descriptor = scheduleMock.mock.calls[0]![6] as any;
    expect(descriptor.key).toBe(KEY);
    expect(descriptor.buildVersion).toBe("v-test");
  });

  it("replays the CAPTURE's initialTheme into the resume payload (theme fidelity)", async () => {
    // initialTheme is per-request metadata, but React resume requires the tail
    // tree to match the frozen prelude, which was rendered with the CAPTURE's
    // theme. The tail must override the visitor's initialTheme with the stored
    // one; the FOUC script + ThemeProvider's post-mount cookie re-sync give the
    // visitor their real theme.
    const store = new MemorySegmentCacheStore();
    await store.putShell(KEY, shellEntry({ initialTheme: "light" }), 300, 30);
    const ssrModule = fullSsrModule();
    const { ctx } = makeCtx(ssrModule, "stream");
    const seen: any[] = [];
    (ctx as any).renderToReadableStream = (payload: unknown) => {
      seen.push(payload);
      return new ReadableStream();
    };

    const request = new Request("http://localhost/p", {
      headers: { accept: "text/html" },
    });
    const url = new URL(request.url);
    const reqCtx = createRequestContext({
      env: {},
      request,
      url,
      variables: {},
    }) as RequestContext<unknown>;
    reqCtx._cacheStore = store as any;
    // The VISITOR's theme differs from the capture's (theme is a getter on the
    // real context — override it).
    Object.defineProperty(reqCtx, "theme", { value: "dark" });
    (reqCtx as any)._classifiedRoute = {
      manifestEntry: { type: "route", ppr: true },
    };

    const response = await runWithRequestContext(reqCtx, () =>
      handleRscRendering(
        ctx,
        request,
        {},
        url,
        false,
        reqCtx._handleStore,
        undefined,
      ),
    );
    expect(response.headers.get("x-rango-shell")).toBe("HIT");
    await readAll(response.body!); // drive the tail
    expect(seen).toHaveLength(1);
    // The payload (SSR resume tree AND client hydration) carries the CAPTURED
    // theme, not the visitor's — trees agree with the frozen prelude.
    expect((seen[0] as any).metadata.initialTheme).toBe("light");
  });

  // Capture data snapshot: on a HIT the tail render (a FULL fresh render for
  // hydration) reads through a SeededShellStore overlay so every cache-store key
  // the capture pinned returns its capture-time value AS FRESH — the fresh
  // payload matches the frozen prelude even after the underlying entries drifted.
  // Everything not pinned falls through to the real store and stays live. See
  // cache/shell-snapshot.ts and docs/design/ppr-shell-resume.md.
  it("seeds the tail render's cache reads from the snapshot (pinned value served fresh, real store untouched)", async () => {
    const store = new MemorySegmentCacheStore();
    // The real store has NO "it1" entry — proving the SEED serves it (the capture
    // pinned it), not a live read. This is exactly the drift case: at HIT time the
    // underlying cache has expired/changed, but the shell must stay byte-identical.
    const snapshot: ShellSnapshotRecord[] = [
      { family: "item", key: "it1", value: { value: "PINNED-AT-CAPTURE" } },
    ];
    await store.putShell(KEY, shellEntry({ snapshot }), 300, 30);
    const getItemSpy = vi.spyOn(store, "getItem");

    const ssrModule = fullSsrModule();
    const { ctx } = makeCtx(ssrModule, "stream");
    const reads: Promise<unknown>[] = [];
    const seen: (string | undefined)[] = [];
    (ctx as any).renderToReadableStream = () => {
      // Model a shell "use cache" read during the tail render — it must resolve
      // to the pinned value, and must NOT reach the real store.
      const p = getRequestContext()._cacheStore!.getItem!("it1").then((r) =>
        seen.push(r?.value),
      );
      reads.push(p);
      return new ReadableStream();
    };

    const request = new Request("http://localhost/p", {
      headers: { accept: "text/html" },
    });
    const url = new URL(request.url);
    const reqCtx = createRequestContext({
      env: {},
      request,
      url,
      variables: {},
    }) as RequestContext<unknown>;
    reqCtx._cacheStore = store as any;
    (reqCtx as any)._classifiedRoute = {
      manifestEntry: { type: "route", ppr: true },
    };

    const response = await runWithRequestContext(reqCtx, () =>
      handleRscRendering(
        ctx,
        request,
        {},
        url,
        false,
        reqCtx._handleStore,
        undefined,
      ),
    );
    expect(response.headers.get("x-rango-shell")).toBe("HIT");
    await readAll(response.body!); // drive the tail render
    await Promise.all(reads);

    expect(seen).toEqual(["PINNED-AT-CAPTURE"]);
    // The pinned key never reached the real store (served fresh from the seed).
    expect(getItemSpy).not.toHaveBeenCalledWith("it1");
    // The shared foreground store is untouched: the seed lives on a derived ctx.
    expect(reqCtx._cacheStore).toBe(store);
  });

  it("a HIT without a snapshot reads the real store (pre-snapshot behavior preserved)", async () => {
    const store = new MemorySegmentCacheStore();
    await store.setItem("it1", "LIVE", { ttl: 60 });
    await store.putShell(KEY, shellEntry(), 300, 30); // no snapshot
    const getItemSpy = vi.spyOn(store, "getItem");

    const ssrModule = fullSsrModule();
    const { ctx } = makeCtx(ssrModule, "stream");
    const reads: Promise<unknown>[] = [];
    const seen: (string | undefined)[] = [];
    (ctx as any).renderToReadableStream = () => {
      const p = getRequestContext()._cacheStore!.getItem!("it1").then((r) =>
        seen.push(r?.value),
      );
      reads.push(p);
      return new ReadableStream();
    };

    const request = new Request("http://localhost/p", {
      headers: { accept: "text/html" },
    });
    const url = new URL(request.url);
    const reqCtx = createRequestContext({
      env: {},
      request,
      url,
      variables: {},
    }) as RequestContext<unknown>;
    reqCtx._cacheStore = store as any;
    (reqCtx as any)._classifiedRoute = {
      manifestEntry: { type: "route", ppr: true },
    };

    await runWithRequestContext(reqCtx, () =>
      handleRscRendering(
        ctx,
        request,
        {},
        url,
        false,
        reqCtx._handleStore,
        undefined,
      ),
    ).then((r) => readAll(r.body!));
    await Promise.all(reads);

    // No overlay: the tail read the live store.
    expect(seen).toEqual(["LIVE"]);
    expect(getItemSpy).toHaveBeenCalledWith("it1");
  });

  // Fragment splice (issue #700): every HIT tail render — snapshot-seeded or
  // not — runs under a derived context carrying _shellFragmentPayload, so its
  // cache/prerender-store hits emit stored fragments verbatim. The flag must
  // never mutate the SHARED reqCtx: scheduleShellCapture derives the capture
  // context from reqCtx, and a capture render seeing the flag would serialize
  // fragment envelopes into records (double-encoding).
  for (const withSnapshot of [true, false]) {
    it(`arms _shellFragmentPayload on the HIT tail context (${withSnapshot ? "snapshot-seeded" : "no snapshot"}) without touching the shared reqCtx`, async () => {
      const store = new MemorySegmentCacheStore();
      const snapshot: ShellSnapshotRecord[] | undefined = withSnapshot
        ? [{ family: "item", key: "it1", value: { value: "PINNED" } }]
        : undefined;
      await store.putShell(KEY, shellEntry({ snapshot }), 300, 30);

      const ssrModule = fullSsrModule();
      const { ctx } = makeCtx(ssrModule, "stream");
      let tailFlag: boolean | undefined;
      (ctx as any).renderToReadableStream = () => {
        tailFlag = getRequestContext()._shellFragmentPayload;
        return new ReadableStream();
      };

      const request = new Request("http://localhost/p", {
        headers: { accept: "text/html" },
      });
      const url = new URL(request.url);
      const reqCtx = createRequestContext({
        env: {},
        request,
        url,
        variables: {},
      }) as RequestContext<unknown>;
      reqCtx._cacheStore = store as any;
      (reqCtx as any)._classifiedRoute = {
        manifestEntry: { type: "route", ppr: true },
      };

      const response = await runWithRequestContext(reqCtx, () =>
        handleRscRendering(
          ctx,
          request,
          {},
          url,
          false,
          reqCtx._handleStore,
          undefined,
        ),
      );
      expect(response.headers.get("x-rango-shell")).toBe("HIT");
      await readAll(response.body!); // drive the tail render

      expect(tailFlag).toBe(true);
      // Own property of the derived tail context only — the shared reqCtx (the
      // capture derivation base) must not carry it.
      expect(
        Object.prototype.hasOwnProperty.call(reqCtx, "_shellFragmentPayload"),
      ).toBe(false);
    });
  }

  it("a stale (SWR) hit serves the stale shell AND schedules a background recapture", async () => {
    const store = new MemorySegmentCacheStore();
    // ttl 0 => stale as soon as the clock advances; swr 300 keeps it servable.
    await store.putShell(KEY, shellEntry(), 0, 300);
    await new Promise((r) => setTimeout(r, 5));
    const ssrModule = fullSsrModule();

    const { response } = await run({ ssrModule, ppr: true, store });

    expect(response.headers.get("x-rango-shell")).toBe("HIT");
    expect(await readAll(response.body!)).toBe(`${PRELUDE_HTML}RESUMED-HOLE`);
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect((scheduleMock.mock.calls[0]![6] as any).key).toBe(KEY);
  });
});

describe("handleRscRendering — integrated PPR serve: bypasses", () => {
  it("no ppr option: pure axis 1 — no store read, no header, no schedule, no logs", async () => {
    const store = new MemorySegmentCacheStore();
    await store.putShell(KEY, shellEntry(), 300, 30); // even with a stored shell
    const getShell = vi.spyOn(store, "getShell");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ssrModule = fullSsrModule();
      const { response } = await run({ ssrModule, store }); // ppr undefined

      expect(ssrModule.renderHTML).toHaveBeenCalledTimes(1);
      expect(ssrModule.resumeShellHTML).not.toHaveBeenCalled();
      expect(response.headers.has("x-rango-shell")).toBe(false);
      expect(getShell).not.toHaveBeenCalled();
      expect(scheduleMock).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("ppr: false behaves exactly like undeclared", async () => {
    const store = new MemorySegmentCacheStore();
    const getShell = vi.spyOn(store, "getShell");
    const { response } = await run({
      ssrModule: fullSsrModule(),
      ppr: false,
      store,
    });
    expect(response.headers.has("x-rango-shell")).toBe(false);
    expect(getShell).not.toHaveBeenCalled();
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it("ctx.dynamic() before the PPR commit point bypasses shell reads and serves axis 1", async () => {
    const store = new MemorySegmentCacheStore();
    await store.putShell(KEY, shellEntry(), 300, 30);
    const getShell = vi.spyOn(store, "getShell");
    const ssrModule = fullSsrModule();

    const { response } = await run({
      ssrModule,
      ppr: true,
      store,
      arm: (reqCtx) => {
        reqCtx.dynamic();
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-rango-shell")).toBeNull();
    expect(getShell).not.toHaveBeenCalled();
    expect(ssrModule.renderHTML).toHaveBeenCalledTimes(1);
    expect(ssrModule.resumeShellHTML).not.toHaveBeenCalled();
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  // A per-request CSP nonce keeps the route on axis 1: useNonce() renders it into
  // the document, so a shell shared per host+URL would freeze one request's nonce
  // for every visitor. The nonce blocks capture whether it came from the provider
  // (createRouter({ nonce }), threaded as the `nonce` param) or from a direct
  // ctx.set(nonce, …) token write in middleware (issue #656). BOTH now warn once
  // per key: a declared route that cannot be honored is a diagnostic-worthy
  // "declared intent cannot be honored", mirroring the missing-store warning.
  it("provider nonce (threaded param) bypasses PPR, warns once per key, no store read, no schedule", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = new MemorySegmentCacheStore();
      await store.putShell(
        "localhost/nonce-provider:shell",
        shellEntry(),
        300,
        30,
      );
      const getShell = vi.spyOn(store, "getShell");
      const ssrModule = fullSsrModule();
      const { response } = await run({
        ssrModule,
        ppr: true,
        store,
        nonce: "abc123",
        url: "http://localhost/nonce-provider",
      });
      // Axis 1: full fizz, no resume, no header, no capture, no store read.
      expect(ssrModule.renderHTML).toHaveBeenCalledTimes(1);
      expect(ssrModule.resumeShellHTML).not.toHaveBeenCalled();
      expect(response.headers.has("x-rango-shell")).toBe(false);
      expect(scheduleMock).not.toHaveBeenCalled();
      expect(getShell).not.toHaveBeenCalled();
      // Warns once, naming the route/key and the nonce cause.
      const warnings = warnSpy.mock.calls.filter(
        (c) =>
          typeof c[0] === "string" && c[0].includes("localhost/nonce-provider"),
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0][0]).toContain("per-request");
      expect(warnings[0][0]).toContain("nonce");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("token nonce (ctx.set(nonce, …) in middleware) bypasses PPR: no store read, no schedule, no header, warns once per key", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = new MemorySegmentCacheStore();
      // Even with a stored, valid shell for this key, the token nonce forces axis 1.
      await store.putShell(
        "localhost/nonce-token:shell",
        shellEntry(),
        300,
        30,
      );
      const getShell = vi.spyOn(store, "getShell");
      const ssrModule = fullSsrModule();

      const armNonce = (reqCtx: RequestContext<unknown>) =>
        contextSet(reqCtx._variables, nonceToken, "tok-nonce-1");

      // First request: warns.
      const first = await run({
        ssrModule,
        ppr: true,
        store,
        url: "http://localhost/nonce-token",
        arm: armNonce,
      });
      expect(ssrModule.renderHTML).toHaveBeenCalledTimes(1);
      expect(ssrModule.resumeShellHTML).not.toHaveBeenCalled();
      // The threaded `nonce` param is undefined — the gate saw ONLY the token.
      expect(first.response.headers.has("x-rango-shell")).toBe(false);
      // The token nonce was never passed through to renderHTML's nonce option
      // (that path is the provider's); the token only gates PPR here.
      expect(scheduleMock).not.toHaveBeenCalled();
      // The store's shell family was never consulted: axis 1, not a HIT.
      expect(getShell).not.toHaveBeenCalled();

      // Second request, same key: warn-once holds.
      await run({
        ssrModule: fullSsrModule(),
        ppr: true,
        store,
        url: "http://localhost/nonce-token",
        arm: armNonce,
      });
      const warnings = warnSpy.mock.calls.filter(
        (c) =>
          typeof c[0] === "string" && c[0].includes("localhost/nonce-token"),
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0][0]).toContain("ppr");
      expect(warnings[0][0]).toContain("nonce");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("token nonce on a NON-ppr route: pure axis 1, no header, no schedule, NO warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = new MemorySegmentCacheStore();
      const getShell = vi.spyOn(store, "getShell");
      const ssrModule = fullSsrModule();
      const { response } = await run({
        ssrModule,
        store, // ppr undefined
        url: "http://localhost/nonce-token-undeclared",
        arm: (reqCtx) =>
          contextSet(reqCtx._variables, nonceToken, "tok-nonce-2"),
      });
      // Undeclared route stays silent: the nonce gate only fires for ppr routes.
      expect(ssrModule.renderHTML).toHaveBeenCalledTimes(1);
      expect(response.headers.has("x-rango-shell")).toBe(false);
      expect(scheduleMock).not.toHaveBeenCalled();
      expect(getShell).not.toHaveBeenCalled();
      const warnings = warnSpy.mock.calls.filter(
        (c) =>
          typeof c[0] === "string" &&
          c[0].includes("localhost/nonce-token-undeclared"),
      );
      expect(warnings).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("allReady buffering (ssr.resolveStreaming) bypasses PPR: one complete axis-1 document", async () => {
    const store = new MemorySegmentCacheStore();
    await store.putShell(KEY, shellEntry(), 300, 30);
    const ssrModule = fullSsrModule();
    const { response } = await run({
      ssrModule,
      ppr: true,
      store,
      streamMode: "allReady",
    });
    expect(ssrModule.renderHTML).toHaveBeenCalledTimes(1);
    expect(ssrModule.resumeShellHTML).not.toHaveBeenCalled();
    expect(response.headers.has("x-rango-shell")).toBe(false);
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it("a store WITHOUT the shell family warns once per key and serves axis 1", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const bareStore = {}; // no getShell/putShell
      const ssrModule = fullSsrModule();
      const first = await run({
        ssrModule,
        ppr: true,
        store: bareStore,
        url: "http://localhost/warn-once",
      });
      expect(first.response.headers.has("x-rango-shell")).toBe(false);
      expect(scheduleMock).not.toHaveBeenCalled();

      await run({
        ssrModule: fullSsrModule(),
        ppr: true,
        store: bareStore,
        url: "http://localhost/warn-once",
      });
      const keyWarnings = warnSpy.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].includes("localhost/warn-once"),
      );
      // Once per key across both requests.
      expect(keyWarnings).toHaveLength(1);
      expect(keyWarnings[0][0]).toContain("getShell/putShell");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("host-scoped keys: one host's shell never serves another host with the same path", async () => {
    const store = new MemorySegmentCacheStore();
    await store.putShell("tenant-a.example/page:shell", shellEntry(), 300, 30);
    const ssrModule = fullSsrModule();

    const { response } = await run({
      ssrModule,
      ppr: true,
      store,
      url: "http://tenant-b.example/page",
    });

    // Tenant B misses: axis 1 + its own host-scoped capture key.
    expect(response.headers.get("x-rango-shell")).toBe("MISS");
    expect(ssrModule.resumeShellHTML).not.toHaveBeenCalled();
    expect((scheduleMock.mock.calls[0]![6] as any).key).toBe(
      "tenant-b.example/page:shell",
    );
  });
});

describe("handleRscRendering — PPR partial navigation replay", () => {
  // The canonical doc segment key for /p — capture stamps it on the entry
  // (docKey) and eligibility requires the exact record under it.
  const DOC_KEY = "doc:localhost/p";
  const segmentRecord: ShellSnapshotRecord = {
    family: "segment",
    key: DOC_KEY,
    value: {
      segments: [
        {
          encoded: "",
          metadata: {
            id: "R0",
          } as CachedEntryData["segments"][number]["metadata"],
        },
      ],
      handles: "",
      expiresAt: Date.now() + 60_000,
    },
  };

  async function expectReplayDeclined(
    options: Pick<RunOpts, "nonce" | "arm" | "store"> & {
      entryOverrides?: Partial<ShellCacheEntry>;
      captureExpected?: boolean;
    },
    reason: string,
  ): Promise<void> {
    let replayArmed = false;

    const { response } = await run({
      ssrModule: fullSsrModule(),
      partial: true,
      ppr: true,
      store: options.store,
      shell: shellEntry({
        snapshot: [segmentRecord],
        docKey: DOC_KEY,
        ...options.entryOverrides,
      }),
      nonce: options.nonce,
      arm: options.arm,
      matchPartial: async () => {
        const active = getRequestContext();
        replayArmed = active._shellImplicitCache?.keyPrefix === "doc";
        return emptyMatchResult();
      },
    });

    expect(replayArmed).toBe(false);
    expect(response.headers.get("x-rango-ppr-replay")).toBe(
      `BYPASS; reason=${reason}`,
    );
    if (options.captureExpected) {
      expect(scheduleMock).toHaveBeenCalledTimes(1);
      expect(scheduleMock.mock.calls[0]![6]).toMatchObject({
        key: NAVIGATION_KEY,
        navigationOnly: true,
      });
    } else {
      expect(scheduleMock).not.toHaveBeenCalled();
    }
  }

  it("passively replays a stale shell without claiming revalidation ownership", async () => {
    const store = new MemorySegmentCacheStore();
    const getShell = vi.spyOn(store, "getShell").mockResolvedValue({
      entry: shellEntry({ snapshot: [segmentRecord], docKey: DOC_KEY }),
      freshness: "stale",
      revalidationClaimed: false,
    });
    let replayArmed = false;

    const { response } = await run({
      ssrModule: fullSsrModule(),
      partial: true,
      ppr: true,
      store,
      matchPartial: async () => {
        const active = getRequestContext();
        const replayStore = active._shellImplicitCache?.store;
        replayArmed = (await replayStore?.get(DOC_KEY)) !== null;
        if (replayArmed) active._shellImplicitCache?.onHit?.();
        return emptyMatchResult();
      },
    });

    expect(replayArmed).toBe(true);
    expect(response.headers.get("x-rango-ppr-replay")).toBe(
      "HIT; freshness=stale",
    );
    expect(getShell).toHaveBeenCalledWith(KEY, { claimRevalidation: false });
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it("seeds the captured document segments while item reads and loaders stay live", async () => {
    const store = new MemorySegmentCacheStore();
    await store.setItem("loader-item", "LIVE", { ttl: 60 });
    let segmentHit = false;
    let itemValue: string | undefined;
    let marker: RequestContext["_shellImplicitCache"];
    let baseContext: RequestContext<unknown> | undefined;

    const { reqCtx, response } = await run({
      ssrModule: fullSsrModule(),
      partial: true,
      ppr: true,
      store,
      shell: shellEntry({
        docKey: DOC_KEY,
        snapshot: [
          segmentRecord,
          {
            family: "item",
            key: "loader-item",
            value: { value: "CAPTURED" },
          },
        ],
      }),
      arm: (active) => {
        baseContext = active;
      },
      matchPartial: async () => {
        const active = getRequestContext();
        const replayStore = active._shellImplicitCache!.store!;
        expect(active).toBe(baseContext);
        expect(active._cacheStore).toBe(store);
        segmentHit = (await replayStore.get(DOC_KEY)) !== null;
        if (segmentHit) active._shellImplicitCache!.onHit?.();
        itemValue = (await replayStore.getItem!("loader-item"))?.value;
        marker = active._shellImplicitCache;
        active.setLocationState({
          __rsc_ls_key: "flash",
          __rsc_ls_value: "preserved",
        });
        return emptyMatchResult();
      },
    });

    expect(segmentHit).toBe(true);
    expect(itemValue).toBe("LIVE");
    expect(marker).toMatchObject({ keyPrefix: "doc" });
    expect(response.headers.get("x-rango-ppr-replay")).toBe(
      "HIT; freshness=fresh",
    );
    expect(reqCtx._shellImplicitCache).toBeUndefined();
    expect(reqCtx._locationState).toEqual([
      { __rsc_ls_key: "flash", __rsc_ls_value: "preserved" },
    ]);
  });

  it("arms _shellFragmentPayload on the SHARED context for the partial match and restores it after (fragment passthrough #700)", async () => {
    let flagDuringMatch: boolean | undefined;
    let baseContext: RequestContext<unknown> | undefined;
    let sameContext = false;

    const { reqCtx, response } = await run({
      ssrModule: fullSsrModule(),
      partial: true,
      ppr: true,
      shell: shellEntry({ snapshot: [segmentRecord], docKey: DOC_KEY }),
      arm: (active) => {
        baseContext = active;
      },
      matchPartial: async () => {
        const active = getRequestContext();
        // Mutate-restore on the SHARED reqCtx, not a derived context: the
        // pipeline's ambient writes during the match (_pprReplayPostMatchReason,
        // location state, _treeHasStreaming) must land on reqCtx.
        sameContext = active === baseContext;
        flagDuringMatch = active._shellFragmentPayload;
        const replayStore = active._shellImplicitCache!.store!;
        if ((await replayStore.get(DOC_KEY)) !== null) {
          active._shellImplicitCache!.onHit?.();
        }
        return emptyMatchResult();
      },
    });

    expect(flagDuringMatch).toBe(true);
    expect(sameContext).toBe(true);
    // Assign-back restore leaves an own `undefined` (the _shellImplicitCache
    // idiom) — assert the value, not hasOwnProperty.
    expect(reqCtx._shellFragmentPayload).toBeUndefined();
    expect(response.headers.get("x-rango-ppr-replay")).toBe(
      "HIT; freshness=fresh",
    );
  });

  it("restores _shellFragmentPayload when the partial match throws a Response (redirect short-circuit)", async () => {
    const redirect = new Response(null, {
      status: 302,
      headers: { location: "/next" },
    });
    let flagDuringMatch: boolean | undefined;
    let captured: RequestContext<unknown> | undefined;

    await expect(
      run({
        ssrModule: fullSsrModule(),
        partial: true,
        ppr: true,
        shell: shellEntry({ snapshot: [segmentRecord], docKey: DOC_KEY }),
        arm: (active) => {
          captured = active;
        },
        matchPartial: async () => {
          flagDuringMatch = getRequestContext()._shellFragmentPayload;
          throw redirect;
        },
      }),
    ).rejects.toBe(redirect);

    expect(flagDuringMatch).toBe(true);
    expect(captured!._shellFragmentPayload).toBeUndefined();
  });

  it.each([
    ["method (non-GET action)", { method: "POST" }],
    [
      "dynamic",
      {
        arm: (active: RequestContext<unknown>) => {
          active._dynamic = true;
        },
      },
    ],
    ["nonce", { nonce: "n-test" }],
    ["no-navigation-context", { navContext: false as const }],
    ["no-fragment-capability", { fragmentCapability: false as const }],
    ["fragment-recovery", { headers: { "X-Rango-Fragment-Recovery": "1" } }],
    ["undeclared ppr", { ppr: undefined }],
  ] as const)(
    "keeps _shellFragmentPayload unarmed on the %s bypass lane",
    async (_lane, extra) => {
      let flagDuringMatch: boolean | undefined = false;

      await run({
        ssrModule: fullSsrModule(),
        partial: true,
        ppr: true,
        shell: shellEntry({ snapshot: [segmentRecord], docKey: DOC_KEY }),
        ...extra,
        matchPartial: async () => {
          flagDuringMatch = getRequestContext()._shellFragmentPayload;
          return emptyMatchResult();
        },
      });

      expect(flagDuringMatch).toBeUndefined();
    },
  );

  it("declines replay when a custom store does not opt into passive shell reads", async () => {
    const getShell = vi.fn();
    await expectReplayDeclined(
      {
        store: {
          getShell,
          putShell: vi.fn(),
        },
      },
      "passive-read-unsupported",
    );

    expect(getShell).not.toHaveBeenCalled();
  });

  it("bypasses a baked prerender route as prerender-store: zero shell reads, no capture, no dev endpoint fetch", async () => {
    // A Prerender()+ppr partial is served from the build-time prerender store
    // inside withCacheLookup; its capture never records a doc segment record
    // (withCacheStore skips on the prerender hit), so replay seeding could
    // never succeed. The gate probes the store for the baked artifact,
    // decides before any getShell read, and must not schedule heal captures
    // (their snapshots would be equally unusable) or foreground-fetch the dev
    // /__rsc_shell endpoint.
    prerenderStoreGetMock.mockResolvedValueOnce({ segments: [] });
    const store = new MemorySegmentCacheStore();
    const getShell = vi.spyOn(store, "getShell");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const { response, ctx } = await run({
      ssrModule: fullSsrModule(),
      partial: true,
      ppr: true,
      store,
      arm: (reqCtx) => {
        (reqCtx._classifiedRoute as any).matched = {
          pr: true,
          routeKey: "p",
          params: {},
        };
      },
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.headers.get("x-rango-ppr-replay")).toBe(
      "BYPASS; reason=prerender-store",
    );
    expect(getShell).not.toHaveBeenCalled();
    expect(scheduleMock).not.toHaveBeenCalled();
    expect(ctx.loadSSRModule).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("a pr route whose baked artifact is missing falls through to the ordinary replay decision", async () => {
    // The trie's pr flag is not a serve guarantee: Passthrough(Prerender())
    // bakes only the listed params — the rest miss the prerender store and
    // render live. Reporting prerender-store for them would blame a store
    // that cannot serve and permanently disable replay AND its heal capture.
    // With no baked artifact (probe resolves null) the ordinary path runs:
    // shell reads happen, no-entry is honest, and the heal capture is
    // scheduled so the NEXT navigation can replay.
    const store = new MemorySegmentCacheStore();
    const getShell = vi.spyOn(store, "getShell");

    const { response } = await run({
      ssrModule: fullSsrModule(),
      partial: true,
      ppr: true,
      store,
      arm: (reqCtx) => {
        (reqCtx._classifiedRoute as any).matched = {
          pr: true,
          routeKey: "p",
          params: { slug: "unbaked" },
        };
      },
    });

    expect(response.headers.get("x-rango-ppr-replay")).toBe(
      "BYPASS; reason=no-entry",
    );
    expect(getShell).toHaveBeenCalled();
    expect(scheduleMock).toHaveBeenCalledTimes(1);
  });

  it("an intercept-source partial to a pr route with an unbaked artifact keeps replay + heal (probe is a safe fast path)", async () => {
    // Whether the navigation IS an intercept resolves in match-api's
    // findInterceptForRoute, after this gate — the header proves nothing in
    // either direction, so the gate probes the normal artifact regardless
    // and relies on post-match reclassification to correct a wrong guess.
    // With no baked artifact the ordinary path runs: shell reads happen,
    // no-entry is honest, and the heal capture stays scheduled.
    prerenderStoreGetMock.mockClear();
    const store = new MemorySegmentCacheStore();
    const getShell = vi.spyOn(store, "getShell");

    const { response } = await run({
      ssrModule: fullSsrModule(),
      partial: true,
      ppr: true,
      store,
      headers: { "X-RSC-Router-Intercept-Source": "/photos" },
      arm: (reqCtx) => {
        (reqCtx._classifiedRoute as any).matched = {
          pr: true,
          routeKey: "p",
          params: {},
        };
      },
    });

    expect(prerenderStoreGetMock).toHaveBeenCalled();
    expect(response.headers.get("x-rango-ppr-replay")).toBe(
      "BYPASS; reason=no-entry",
    );
    expect(getShell).toHaveBeenCalled();
    expect(scheduleMock).toHaveBeenCalledTimes(1);
  });

  it("reclassifies a cold-shell miss to prerender-store when the store actually served, and suppresses the heal", async () => {
    // The pre-match probe reads only the non-intercept artifact; a baked /i
    // variant serves inside the match (tryPrerenderLookup stamps the
    // post-match reason). Reporting no-entry and scheduling a heal
    // would blame a cold capture for a lane the prerender store owns — its
    // captures record no doc record, so the healed snapshot could never
    // become consumable.
    const { response } = await run({
      ssrModule: fullSsrModule(),
      partial: true,
      ppr: true,
      headers: { "X-RSC-Router-Intercept-Source": "/photos" },
      matchPartial: async () => {
        getRequestContext()._pprReplayPostMatchReason = "prerender-store";
        return emptyMatchResult();
      },
    });

    expect(response.headers.get("x-rango-ppr-replay")).toBe(
      "BYPASS; reason=prerender-store",
    );
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it("reports intercept when the match resolved an intercept, and suppresses the heal", async () => {
    // Intercepts keep their normal cache path (match-api never arms replay
    // for them), so neither the no-entry token nor a background document
    // capture belongs to this navigation.
    const { response } = await run({
      ssrModule: fullSsrModule(),
      partial: true,
      ppr: true,
      matchPartial: async () => {
        getRequestContext()._pprReplayPostMatchReason = "intercept";
        return emptyMatchResult();
      },
    });

    expect(response.headers.get("x-rango-ppr-replay")).toBe(
      "BYPASS; reason=intercept",
    );
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it("corrects a pre-match prerender-store guess to intercept when the match resolved an intercept that rendered live", async () => {
    // The probe found the NORMAL artifact, but the match resolved an
    // intercept whose /i variant is unbaked — the store did not serve.
    // The reported token follows the match, not the guess.
    prerenderStoreGetMock.mockResolvedValueOnce({ segments: [] });
    const { response } = await run({
      ssrModule: fullSsrModule(),
      partial: true,
      ppr: true,
      headers: { "X-RSC-Router-Intercept-Source": "/photos" },
      arm: (reqCtx) => {
        (reqCtx._classifiedRoute as any).matched = {
          pr: true,
          routeKey: "p",
          params: {},
        };
      },
      matchPartial: async () => {
        getRequestContext()._pprReplayPostMatchReason = "intercept";
        return emptyMatchResult();
      },
    });

    expect(response.headers.get("x-rango-ppr-replay")).toBe(
      "BYPASS; reason=intercept",
    );
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it("a false condition() with no replayable snapshot reports cache-disabled through the report-only marker and suppresses the heal", async () => {
    // An always-false condition() route never produces a doc record (the
    // write opt-out is absolute), so the eligible-snapshot path can never
    // arm. The report-only marker (no store — nothing can serve through it)
    // still surfaces the lookup's refusal, and the heal capture is
    // suppressed: its snapshot would be equally unusable.
    let markerStore: unknown = "unset";
    const { response } = await run({
      ssrModule: fullSsrModule(),
      partial: true,
      ppr: true,
      arm: (reqCtx) => {
        (reqCtx._classifiedRoute as any).manifestEntry.cache = {
          options: { ttl: 30, condition: () => false },
        };
      },
      matchPartial: async () => {
        const marker = getRequestContext()._shellImplicitCache;
        markerStore = marker?.store;
        // What withCacheLookup does when lookupRouteDetailed classifies the
        // explicit lookup `bypass` (condition refused).
        marker?.onExplicitBypass?.();
        return emptyMatchResult();
      },
    });

    expect(markerStore).toBeUndefined();
    expect(response.headers.get("x-rango-ppr-replay")).toBe(
      "BYPASS; reason=cache-disabled",
    );
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it("an explicit-tier hit with no shell entry reports explicit-cache-hit and still schedules the heal", async () => {
    // The consumer's tier served (truthful token), but the shell itself is
    // cold — the navigation-only heal capture stays scheduled so replay can
    // engage once the tier expires.
    const { response } = await run({
      ssrModule: fullSsrModule(),
      partial: true,
      ppr: true,
      arm: (reqCtx) => {
        (reqCtx._classifiedRoute as any).manifestEntry.cache = {
          options: { ttl: 30 },
        };
      },
      matchPartial: async () => {
        getRequestContext()._shellImplicitCache?.onExplicitHit?.();
        return emptyMatchResult();
      },
    });

    expect(response.headers.get("x-rango-ppr-replay")).toBe(
      "BYPASS; reason=explicit-cache-hit",
    );
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(scheduleMock.mock.calls[0]![6]).toMatchObject({
      key: NAVIGATION_KEY,
      navigationOnly: true,
    });
  });

  it("heals a snapshot-less entry once the scope's lookup no longer refuses (condition false -> true)", async () => {
    // An entry captured while condition() was false legitimately lacks a
    // snapshot (the doc-record write refusal is absolute). When a later
    // request's lookup does NOT refuse, the heal capture derives from THAT
    // request's context — its doc record records, and replay becomes
    // available without waiting for the document to recapture.
    const { response } = await run({
      ssrModule: fullSsrModule(),
      partial: true,
      ppr: true,
      shell: shellEntry({ snapshot: [] }),
      arm: (reqCtx) => {
        (reqCtx._classifiedRoute as any).manifestEntry.cache = {
          options: { ttl: 30, condition: () => true },
        };
      },
      matchPartial: async () => emptyMatchResult(),
    });

    expect(response.headers.get("x-rango-ppr-replay")).toBe(
      "BYPASS; reason=no-segment-snapshot",
    );
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(scheduleMock.mock.calls[0]![6]).toMatchObject({
      key: NAVIGATION_KEY,
      navigationOnly: true,
    });
  });

  it("does NOT heal a snapshot-less entry while the scope's lookup still refuses (condition false)", async () => {
    // The always-false route's every lookup refuses; healing it would burn a
    // background document render per navigation for a snapshot that can
    // never become consumable.
    const { response } = await run({
      ssrModule: fullSsrModule(),
      partial: true,
      ppr: true,
      shell: shellEntry({ snapshot: [] }),
      arm: (reqCtx) => {
        (reqCtx._classifiedRoute as any).manifestEntry.cache = {
          options: { ttl: 30, condition: () => false },
        };
      },
      matchPartial: async () => {
        getRequestContext()._shellImplicitCache?.onExplicitBypass?.();
        return emptyMatchResult();
      },
    });

    expect(response.headers.get("x-rango-ppr-replay")).toBe(
      "BYPASS; reason=cache-disabled",
    );
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it("an HMR partial to a prerender route falls through to the ordinary replay decision", async () => {
    // withCacheLookup declines the prerender-store lookup on X-RSC-HMR (the
    // memoized build entry may be stale mid-edit), so the gate must share
    // that predicate (prerenderStoreShortCircuits): reporting
    // `prerender-store` here would blame a store that never served.
    const store = new MemorySegmentCacheStore();

    const { response } = await run({
      ssrModule: fullSsrModule(),
      partial: true,
      ppr: true,
      store,
      headers: { "X-RSC-HMR": "1" },
      arm: (reqCtx) => {
        (reqCtx._classifiedRoute as any).matched = { pr: true };
      },
    });

    expect(response.headers.get("x-rango-ppr-replay")).toBe(
      "BYPASS; reason=no-entry",
    );
  });

  it("resolves allReady policy lazily and declines background navigation capture", async () => {
    const { response, ctx } = await run({
      ssrModule: fullSsrModule(),
      streamMode: "allReady",
      partial: true,
      ppr: true,
    });

    expect(response.status).toBe(200);
    expect(ctx.loadSSRModule).not.toHaveBeenCalled();
    expect(ctx.resolveStreamMode).not.toHaveBeenCalled();
    const resolveModule = scheduleMock.mock.calls[0]![5] as (
      request: Request,
      url: URL,
    ) => Promise<SSRModule | null>;
    const captureUrl = new URL("http://localhost/p");
    await expect(
      resolveModule(
        new Request(captureUrl, { headers: { accept: "text/html" } }),
        captureUrl,
      ),
    ).resolves.toBeNull();
    expect(ctx.loadSSRModule).toHaveBeenCalledTimes(1);
    expect(ctx.resolveStreamMode).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["handler-live holes", { handlerLiveHoles: true }, "handler-live-holes"],
    ["conditional transitions", { transitionWhen: true }, "transition-when"],
    ["a missing segment snapshot", { snapshot: [] }, "no-segment-snapshot"],
    [
      "a malformed snapshot record",
      { snapshot: [null] as unknown as ShellSnapshotRecord[] },
      "no-segment-snapshot",
    ],
    [
      "an empty segment snapshot",
      {
        snapshot: [
          {
            ...segmentRecord,
            value: {
              ...(segmentRecord.value as CachedEntryData),
              segments: [],
            },
          },
        ],
      },
      "no-segment-snapshot",
    ],
  ] as const)("declines replay for %s", async (_label, overrides, reason) =>
    expectReplayDeclined(
      { entryOverrides: overrides as Partial<ShellCacheEntry> },
      reason,
    ),
  );

  it.each([
    [
      "an invalid build version",
      { buildVersion: "other-build" },
      "invalid-version",
    ],
    ["a corrupt prelude", { prelude: "%%%" }, "corrupt-entry"],
  ] as const)(
    "heals %s with a navigation capture",
    async (_label, overrides, reason) =>
      expectReplayDeclined(
        {
          entryOverrides: overrides as Partial<ShellCacheEntry>,
          captureExpected: true,
        },
        reason,
      ),
  );

  it("falls back to the separate navigation snapshot when no document shell exists", async () => {
    const store = new MemorySegmentCacheStore();
    await store.putShell(
      NAVIGATION_KEY,
      shellEntry({
        navigationOnly: true,
        snapshot: [segmentRecord],
        docKey: DOC_KEY,
      }),
      300,
    );
    let replayArmed = false;

    const { response } = await run({
      ssrModule: fullSsrModule(),
      partial: true,
      ppr: true,
      store,
      matchPartial: async () => {
        const active = getRequestContext();
        replayArmed = active._shellImplicitCache !== undefined;
        active._shellImplicitCache?.onHit?.();
        return emptyMatchResult();
      },
    });

    expect(replayArmed).toBe(true);
    expect(response.headers.get("x-rango-ppr-replay")).toBe(
      "HIT; freshness=fresh",
    );
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it.each([
    ["an active nonce", { nonce: "request-nonce" }, "nonce"],
    [
      "ctx.dynamic()",
      { arm: (reqCtx: RequestContext<unknown>) => (reqCtx._dynamic = true) },
      "dynamic",
    ],
  ] as const)("declines replay for %s", async (_label, options, reason) =>
    expectReplayDeclined(options, reason),
  );

  it("reports a bounded no-entry bypass for a missing or hard-expired shell", async () => {
    const store = new MemorySegmentCacheStore();
    const { response } = await run({
      ssrModule: fullSsrModule(),
      partial: true,
      ppr: true,
      store,
    });

    expect(response.headers.get("x-rango-ppr-replay")).toBe(
      "BYPASS; reason=no-entry",
    );
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(scheduleMock.mock.calls[0]![6]).toMatchObject({
      key: NAVIGATION_KEY,
      navigationOnly: true,
    });
  });

  it("reports snapshot-miss when an eligible snapshot is not consumed by matching", async () => {
    const { response } = await run({
      ssrModule: fullSsrModule(),
      partial: true,
      ppr: true,
      shell: shellEntry({ snapshot: [segmentRecord], docKey: DOC_KEY }),
    });

    expect(response.headers.get("x-rango-ppr-replay")).toBe(
      "BYPASS; reason=snapshot-miss",
    );
  });

  it("heals a seeded document snapshot at the key that would otherwise shadow the repair", async () => {
    const { response } = await run({
      ssrModule: fullSsrModule(),
      partial: true,
      fragmentCapability: false,
      ppr: true,
      shell: shellEntry({ snapshot: [segmentRecord], docKey: DOC_KEY }),
      matchPartial: async () => {
        getRequestContext()._shellImplicitCache?.onCorrupt?.();
        return emptyMatchResult();
      },
    });

    expect(response.headers.get("x-rango-ppr-replay")).toBe(
      "BYPASS; reason=snapshot-miss",
    );
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(scheduleMock.mock.calls[0]![6]).toMatchObject({
      key: KEY,
      navigationOnly: true,
    });
  });

  it("bypasses a context-less partial as no-navigation-context: zero shell reads, no seeding, no capture", async () => {
    // curl probes and synthetic monitors carry neither X-RSC-Router-Client-Path
    // nor Referer; such a partial can never match, so the old flow spent two
    // getShell reads + seeding only to misreport `snapshot-miss`.
    const store = new MemorySegmentCacheStore();
    const getShell = vi.spyOn(store, "getShell");
    let replayArmed = false;

    const { response } = await run({
      ssrModule: fullSsrModule(),
      partial: true,
      navContext: false,
      ppr: true,
      store,
      shell: shellEntry({ snapshot: [segmentRecord], docKey: DOC_KEY }),
      matchPartial: async () => {
        replayArmed =
          getRequestContext()._shellImplicitCache?.keyPrefix === "doc";
        return emptyMatchResult();
      },
    });

    expect(response.headers.get("x-rango-ppr-replay")).toBe(
      "BYPASS; reason=no-navigation-context",
    );
    expect(replayArmed).toBe(false);
    expect(getShell).not.toHaveBeenCalled();
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it("bypasses a cache(false) route as cache-disabled: zero shell reads, no capture", async () => {
    // Statically disabled — the only opt-out the gate may pre-decide.
    const store = new MemorySegmentCacheStore();
    const getShell = vi.spyOn(store, "getShell");
    let replayArmed = false;

    const { response } = await run({
      ssrModule: fullSsrModule(),
      partial: true,
      ppr: true,
      store,
      shell: shellEntry({ snapshot: [segmentRecord], docKey: DOC_KEY }),
      arm: (reqCtx) => {
        (reqCtx._classifiedRoute as any).manifestEntry.cache = {
          options: false,
        };
      },
      matchPartial: async () => {
        replayArmed =
          getRequestContext()._shellImplicitCache?.keyPrefix === "doc";
        return emptyMatchResult();
      },
    });

    expect(response.headers.get("x-rango-ppr-replay")).toBe(
      "BYPASS; reason=cache-disabled",
    );
    expect(replayArmed).toBe(false);
    expect(getShell).not.toHaveBeenCalled();
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it("a false condition() is decided at the lookup, not the gate: replay arms, and the refusal reports cache-disabled post-match", async () => {
    // A predicate is request-time state — pre-deciding it at the gate would
    // let a false-then-true flap report cache-disabled while the explicit
    // tier serves. The gate lets the request through (shell reads happen);
    // withCacheLookup's own evaluation refuses the read and fires
    // onExplicitBypass, and the header still says cache-disabled.
    const store = new MemorySegmentCacheStore();
    const getShell = vi.spyOn(store, "getShell");
    let replayArmed = false;

    const { response } = await run({
      ssrModule: fullSsrModule(),
      partial: true,
      ppr: true,
      store,
      shell: shellEntry({ snapshot: [segmentRecord], docKey: DOC_KEY }),
      arm: (reqCtx) => {
        (reqCtx._classifiedRoute as any).manifestEntry.cache = {
          options: { ttl: 30, condition: () => false },
        };
      },
      matchPartial: async () => {
        const marker = getRequestContext()._shellImplicitCache;
        replayArmed = marker?.keyPrefix === "doc";
        // What withCacheLookup does on a `bypass` lookup outcome.
        marker?.onExplicitBypass?.();
        return emptyMatchResult();
      },
    });

    expect(response.headers.get("x-rango-ppr-replay")).toBe(
      "BYPASS; reason=cache-disabled",
    );
    expect(replayArmed).toBe(true);
    expect(getShell).toHaveBeenCalled();
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it("an app-wide cache() scope (enabled, no condition) does NOT gate replay off", async () => {
    // The storefront shape: the route inherits a cache() from an ancestor.
    // Replay must proceed to the shell reads and seed the overlay — the
    // explicit tier composes downstream instead of disabling the tier.
    let replayArmed = false;

    const { response } = await run({
      ssrModule: fullSsrModule(),
      partial: true,
      ppr: true,
      shell: shellEntry({ snapshot: [segmentRecord], docKey: DOC_KEY }),
      arm: (reqCtx) => {
        (reqCtx._classifiedRoute as any).manifestEntry.cache = {
          options: { ttl: 30, swr: 604_800 },
        };
      },
      matchPartial: async () => {
        const active = getRequestContext();
        replayArmed = active._shellImplicitCache?.keyPrefix === "doc";
        active._shellImplicitCache?.onHit?.();
        return emptyMatchResult();
      },
    });

    expect(replayArmed).toBe(true);
    expect(response.headers.get("x-rango-ppr-replay")).toBe(
      "HIT; freshness=fresh",
    );
  });

  it("reports explicit-cache-hit when the route-derived tier supplied the match (no false replay HIT)", async () => {
    const { response } = await run({
      ssrModule: fullSsrModule(),
      partial: true,
      ppr: true,
      shell: shellEntry({ snapshot: [segmentRecord], docKey: DOC_KEY }),
      arm: (reqCtx) => {
        (reqCtx._classifiedRoute as any).manifestEntry.cache = {
          options: { ttl: 30 },
        };
      },
      matchPartial: async () => {
        // withCacheLookup fires this when the explicit scope's own lookup
        // hits; the seeded record was not consumed.
        getRequestContext()._shellImplicitCache?.onExplicitHit?.();
        return emptyMatchResult();
      },
    });

    expect(response.headers.get("x-rango-ppr-replay")).toBe(
      "BYPASS; reason=explicit-cache-hit",
    );
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it("a consumed seeded record wins over a same-request explicit hit in the status precedence", async () => {
    // Different cache() boundaries can resolve within one match (e.g. an
    // intercept slot on its normal path). The replay header reports the doc
    // record's consumption — the thing that actually replayed the shell.
    const { response } = await run({
      ssrModule: fullSsrModule(),
      partial: true,
      ppr: true,
      shell: shellEntry({ snapshot: [segmentRecord], docKey: DOC_KEY }),
      matchPartial: async () => {
        const marker = getRequestContext()._shellImplicitCache;
        marker?.onExplicitHit?.();
        marker?.onHit?.();
        return emptyMatchResult();
      },
    });

    expect(response.headers.get("x-rango-ppr-replay")).toBe(
      "HIT; freshness=fresh",
    );
  });

  it("declines an entry stored before the docKey field existed (no crash, honest no-segment-snapshot)", async () =>
    expectReplayDeclined(
      { entryOverrides: { docKey: undefined } },
      "no-segment-snapshot",
    ));

  it("declines an entry whose docKey names a record the snapshot does not carry", async () =>
    expectReplayDeclined(
      { entryOverrides: { docKey: "doc:localhost/other" } },
      "no-segment-snapshot",
    ));
});

describe("handleRscRendering — no PPR flags is byte-identical axis 1", () => {
  it("renders via renderHTML with the normal content-type, no markers, no capture", async () => {
    const ssrModule = fullSsrModule();
    const { response } = await run({ ssrModule });

    expect(ssrModule.renderHTML).toHaveBeenCalledTimes(1);
    expect(ssrModule.captureShellHTML).not.toHaveBeenCalled();
    expect(ssrModule.resumeShellHTML).not.toHaveBeenCalled();
    expect(scheduleMock).not.toHaveBeenCalled();
    expect(response.headers.get("content-type")).toBe(
      "text/html;charset=utf-8",
    );
    expect(response.headers.has("x-rango-shell")).toBe(false);
    expect(response.status).toBe(200);
  });
});
