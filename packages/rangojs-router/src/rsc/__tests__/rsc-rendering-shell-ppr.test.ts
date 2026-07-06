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
  getRequestContext,
  type RequestContext,
} from "../../server/request-context.js";
import type { ShellSnapshotRecord } from "../../cache/types.js";
import { contextSet } from "../../context-var.js";
import { nonce as nonceToken } from "../nonce.js";
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
