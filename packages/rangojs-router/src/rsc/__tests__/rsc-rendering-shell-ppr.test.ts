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

import React from "react";
import { handleRscRendering } from "../rsc-rendering.js";
import { scheduleShellCapture } from "../shell-capture.js";
import { MemorySegmentCacheStore } from "../../cache/memory-segment-store.js";
import type { ShellCacheEntry } from "../../cache/types.js";
import {
  createRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../server/request-context.js";
import type { HandlerContext } from "../handler-context.js";
import type { RscPayload, SSRModule } from "../types.js";
import type { PartialPrerenderProps } from "../../urls/pattern-types.js";

const scheduleMock = vi.mocked(scheduleShellCapture);

const PRELUDE_HTML = "<html><body>SHELL-PRELUDE</body></html>";

function shellEntry(overrides: Partial<ShellCacheEntry> = {}): ShellCacheEntry {
  return {
    prelude: btoa(PRELUDE_HTML),
    postponed: JSON.stringify({ hole: 1 }),
    reactVersion: React.version,
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
        segments: [],
        matched: [],
        diff: [],
        resolvedIds: [],
        params: {},
        routeName: "home",
      })),
    },
    callOnError: vi.fn(),
    renderToReadableStream: (payload: RscPayload) => {
      void payload;
      return new ReadableStream();
    },
    loadSSRModule: async () => ssrModule,
    resolveStreamMode: async () => streamMode,
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
  arm?: (reqCtx: RequestContext<unknown>) => void;
}

async function run(opts: RunOpts): Promise<{
  response: Response;
  reqCtx: RequestContext<unknown>;
  ctx: HandlerContext<unknown>;
  store: MemorySegmentCacheStore;
}> {
  const { ctx } = makeCtx(opts.ssrModule, opts.streamMode ?? "stream");
  const request = new Request(opts.url ?? "http://localhost/p", {
    headers: { accept: "text/html" },
  });
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
  // The classified route snapshot the RSC handler stores before dispatching the
  // render; the integrated PPR path reads the matched entry's ppr option off it.
  (reqCtx as any)._classifiedRoute = {
    manifestEntry: {
      type: "route",
      ...(opts.ppr !== undefined ? { ppr: opts.ppr } : {}),
    },
  };
  opts.arm?.(reqCtx);

  const response = await runWithRequestContext(reqCtx, () =>
    handleRscRendering(
      ctx,
      request,
      {},
      url,
      false,
      reqCtx._handleStore,
      opts.nonce,
    ),
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

beforeEach(() => {
  scheduleMock.mockClear();
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

  it("a per-request nonce bypasses PPR entirely (axis 1, no header, no schedule)", async () => {
    const store = new MemorySegmentCacheStore();
    await store.putShell(KEY, shellEntry(), 300, 30);
    const ssrModule = fullSsrModule();
    const { response } = await run({
      ssrModule,
      ppr: true,
      store,
      nonce: "abc123",
    });
    expect(ssrModule.renderHTML).toHaveBeenCalledTimes(1);
    expect(ssrModule.resumeShellHTML).not.toHaveBeenCalled();
    expect(response.headers.has("x-rango-shell")).toBe(false);
    expect(scheduleMock).not.toHaveBeenCalled();
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
