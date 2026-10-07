import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

// The partitioned request's build-shell probe, observed.
vi.mock("../shell-build-manifest.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../shell-build-manifest.js")>();
  return { ...actual, hasBuildShell: vi.fn(actual.hasBuildShell) };
});

// The partial replay's loader seed decode: observed, and stubbed per test
// (the real decode needs the Flight codec this config cannot load).
vi.mock("../../cache/shell-snapshot.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../cache/shell-snapshot.js")>();
  return {
    ...actual,
    buildShellLoaderSeed: vi.fn(actual.buildShellLoaderSeed),
  };
});

import React from "react";
import { createRouter } from "../../router.js";
import { createLoader } from "../../loader.rsc.js";
import { createHandle } from "../../handle.js";
import { buildRouterTrieFromUrlpatterns } from "../manifest-init.js";
import { handleRscRendering } from "../rsc-rendering.js";
import {
  scheduleShellCapture,
  type ShellCaptureDebugEvent,
} from "../shell-capture.js";
import {
  createWarmRecord,
  type PrerenderWarmRecord,
} from "../../prerender/warm-request.js";
import { MemorySegmentCacheStore } from "../../cache/memory-segment-store.js";
import {
  hasBuildShell,
  resetBuildShellManifestForTests,
} from "../shell-build-manifest.js";
import { buildShellManifestKey } from "../../prerender/shell-manifest-key.js";
import { installNativeBase64 } from "../../cache/cf/__tests__/native-base64.js";
import {
  CFCacheStore,
  resetCFShellMemoForTests,
} from "../../cache/cf/cf-cache-store.js";
import { VercelCacheStore } from "../../cache/vercel/vercel-cache-store.js";
import type { StoreMemoOptions } from "../../cache/shell-memo.js";
import type {
  CachedEntryData,
  ShellCacheEntry,
  ShellDocumentRead,
} from "../../cache/types.js";
import {
  createRequestContext,
  runWithRequestContext,
  getRequestContext,
  type RequestContext,
} from "../../server/request-context.js";
import type { ShellSnapshotRecord } from "../../cache/types.js";
import {
  ShellRecordUnavailableError,
  buildShellLoaderSeed,
  type ShellLoaderSeedEntry,
} from "../../cache/shell-snapshot.js";
import { contextSet } from "../../context-var.js";
import { nonce as nonceToken } from "../nonce.js";
import type { HandlerContext } from "../handler-context.js";
import { SSR_SETUP_VAR, type SSRSetup } from "../ssr-setup.js";
import type { RscPayload, SSRModule } from "../types.js";
import type { PartialPrerenderProps } from "../../urls/pattern-types.js";
import { createMetricsStore } from "../../router/metrics.js";
import type { MetricsStore } from "../../server/context.js";
import { composeCacheKeys } from "../../cache/cache-key-utils.js";
import {
  buildShellKey,
  partitionShellKey,
  resetShellServeStateForTests,
  shellReloadScript,
  takeShellTailTimingForServerTiming,
  withoutShellMissMarker,
} from "../shell-serve.js";

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
    // A document entry a HIT can serve names its doc record (the serve gate
    // treats one without it as a MISS). The stubbed router.match never
    // consults it.
    docKey: "doc:localhost/p",
    createdAt: Date.now(),
    snapshot: [],
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

  const response = await runWithRequestContext(reqCtx, () =>
    handleRscRendering(
      ctx,
      request,
      {},
      url,
      opts.partial ?? false,
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

const KEY = "test-router@localhost/p:shell";
const NAVIGATION_KEY = `${KEY}:navigation`;

beforeEach(() => {
  scheduleMock.mockClear();
  vi.mocked(buildShellLoaderSeed).mockReset();
});

describe("handleRscRendering — integrated PPR serve: MISS", () => {
  it("reads the shell while early SSR setup is still pending", async () => {
    const store = new MemorySegmentCacheStore();
    const getShell = vi.spyOn(store, "getShell");
    const ssrModule = fullSsrModule();
    let resolveSSRSetup!: (setup: SSRSetup) => void;
    const ssrSetup = new Promise<SSRSetup>((resolve) => {
      resolveSSRSetup = resolve;
    });

    const rendering = run({
      ssrModule,
      ppr: true,
      store,
      arm: (reqCtx) => {
        reqCtx._variables[SSR_SETUP_VAR] = ssrSetup;
      },
    });

    await vi.waitFor(() => expect(getShell).toHaveBeenCalledTimes(1));
    resolveSSRSetup([ssrModule, "stream"]);
    await rendering;
  });

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

  it("never serves a slim navigation-only entry (no stored document half) as an HTML document", async () => {
    // The write path drops prelude/postponed on navigationOnly entries; the
    // document read must keep treating them as a MISS on the flag alone.
    const store = new MemorySegmentCacheStore();
    const slim = shellEntry({ navigationOnly: true, snapshot: [] });
    delete slim.prelude;
    delete slim.postponed;
    await store.putShell(KEY, slim, 300);
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

  it("ctx.dynamic() during axis-1 render suppresses the follow-up shell capture", async () => {
    const ssrModule = fullSsrModule();
    (ssrModule.renderHTML as any).mockImplementation(async () => {
      getRequestContext().dynamic();
      return streamOf("<html>axis1</html>");
    });

    const { response } = await run({ ssrModule, ppr: true });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-rango-shell")).toBeNull();
    expect(ssrModule.renderHTML).toHaveBeenCalledTimes(1);
    expect(scheduleMock).not.toHaveBeenCalled();
  });
});

/**
 * Calls to the base64 decoders whose input is `b64`: atob (the loop path) and
 * Uint8Array.fromBase64 (the native path, installed here when `native` is
 * set). cf-base64 looks the native method up per call, so the spy sees every
 * native decode. `restore` must run in a `finally`: a spy a failed test leaves
 * on atob leaks into the next test's count.
 */
function spyPreludeDecodes(
  b64: string,
  native: boolean,
): { count: () => number; native: () => number; restore: () => void } {
  const restoreNative = native ? installNativeBase64() : () => {};
  const atobSpy = vi.spyOn(globalThis, "atob");
  const hasNative =
    typeof (Uint8Array as { fromBase64?: unknown }).fromBase64 === "function";
  const nativeSpy = hasNative
    ? vi.spyOn(Uint8Array as any, "fromBase64")
    : undefined;
  return {
    count: () =>
      atobSpy.mock.calls.filter(([s]) => s === b64).length +
      (nativeSpy?.mock.calls.filter(([s]) => s === b64).length ?? 0),
    native: () => nativeSpy?.mock.calls.filter(([s]) => s === b64).length ?? 0,
    restore: () => {
      atobSpy.mockRestore();
      nativeSpy?.mockRestore();
      restoreNative();
    },
  };
}

/** A prelude of exactly `size` ASCII bytes, as stored (base64). */
function asciiPreludeBase64(size: number): string {
  return btoa("a".repeat(size));
}

// The gate before the commit: a HIT replays the handler layer (the entry's
// doc record, or a Prerender route's prerender store) and never runs a
// handler, so whatever cannot be replayed is decided here, before any shell
// byte.
describe("handleRscRendering — integrated PPR serve: the gate before the commit", () => {
  it("serves a document entry without a doc record as a MISS and recaptures it", async () => {
    const store = new MemorySegmentCacheStore();
    await store.putShell(KEY, shellEntry({ docKey: undefined }), 300, 30);
    const ssrModule = fullSsrModule();

    const { response } = await run({ ssrModule, ppr: true, store });

    expect(response.headers.get("x-rango-shell")).toBe("MISS");
    expect(ssrModule.resumeShellHTML).not.toHaveBeenCalled();
    expect(ssrModule.renderHTML).toHaveBeenCalledTimes(1);
    expect(scheduleMock).toHaveBeenCalledTimes(1);
  });

  it("serves a Prerender route's entry without a doc record as a HIT (the prerender store supplies the handler layer)", async () => {
    const store = new MemorySegmentCacheStore();
    await store.putShell(KEY, shellEntry({ docKey: undefined }), 300, 30);
    const ssrModule = fullSsrModule();

    const { response } = await run({
      ssrModule,
      ppr: true,
      store,
      arm: (reqCtx) => {
        (reqCtx._classifiedRoute as any).matched = { pr: true };
      },
    });

    expect(response.headers.get("x-rango-shell")).toBe("HIT");
    await readAll(response.body!);
    expect(ssrModule.resumeShellHTML).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["cache(false)", { options: false as const }],
    [
      "a condition() that refuses this request",
      { options: { ttl: 30, condition: () => false } },
    ],
  ])(
    "renders %s on a ppr route like a cache miss: axis 1, no shell header, no capture",
    async (_label, cache) => {
      const store = new MemorySegmentCacheStore();
      await store.putShell(KEY, shellEntry(), 300, 30);
      const getShell = vi.spyOn(store, "getShell");
      const ssrModule = fullSsrModule();

      const { response } = await run({
        ssrModule,
        ppr: true,
        store,
        arm: (reqCtx) => {
          (reqCtx._classifiedRoute as any).manifestEntry.cache = cache;
        },
      });

      expect(response.headers.get("x-rango-shell")).toBeNull();
      expect(ssrModule.renderHTML).toHaveBeenCalledTimes(1);
      expect(ssrModule.resumeShellHTML).not.toHaveBeenCalled();
      expect(getShell).not.toHaveBeenCalled();
      expect(scheduleMock).not.toHaveBeenCalled();
    },
  );

  // The degrade's reload (shellReloadScript) carries the forced-MISS marker;
  // the handler strips it and flags the request context.
  it("renders a request flagged forced-MISS on axis 1 over a stored shell, with no capture", async () => {
    const store = new MemorySegmentCacheStore();
    await store.putShell(KEY, shellEntry(), 300, 30);
    const getShell = vi.spyOn(store, "getShell");
    const ssrModule = fullSsrModule();

    const { response } = await run({
      ssrModule,
      ppr: true,
      store,
      arm: (reqCtx) => {
        reqCtx._shellForcedMiss = true;
      },
    });

    expect(response.headers.get("x-rango-shell")).toBeNull();
    expect(ssrModule.renderHTML).toHaveBeenCalledTimes(1);
    expect(getShell).not.toHaveBeenCalled();
    expect(scheduleMock).not.toHaveBeenCalled();
    // The marker never partitions the shell key.
    expect(
      buildShellKey(
        "test-router",
        new URL("http://localhost/p?_rsc_shell=miss"),
      ),
    ).toBe(KEY);
  });

  it("a partitioned request for a route with no build shell does not warn, and the route is probed once", async () => {
    resetShellServeStateForTests();
    vi.mocked(hasBuildShell).mockClear();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = Object.assign(new MemorySegmentCacheStore(), {
      keyGenerator: (_ctx: RequestContext, defaultKey: string) =>
        `${defaultKey}|segment`,
    });
    try {
      const { response } = await run({
        ssrModule: fullSsrModule(),
        ppr: true,
        store,
      });
      expect(response.headers.get("x-rango-shell")).toBe("MISS");
      await run({ ssrModule: fullSsrModule(), ppr: true, store });
      expect(
        warn.mock.calls.filter(([m]) => String(m).includes("build-time shell")),
      ).toEqual([]);
      expect(hasBuildShell).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  /** The route-window warnings two dev requests to "product" emit. */
  async function windowWarnings(
    ppr: { ttl?: number; swr?: number },
    cache: { ttl: number; swr?: number },
  ): Promise<string[]> {
    resetShellServeStateForTests();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const arm = (reqCtx: RequestContext<unknown>) => {
      (reqCtx._classifiedRoute as any).routeKey = "product";
      (reqCtx._classifiedRoute as any).manifestEntry.cache = {
        options: cache,
      };
    };
    try {
      await run({ ssrModule: fullSsrModule(), ppr, arm });
      await run({ ssrModule: fullSsrModule(), ppr, arm });
      return warn.mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.includes("never outlives"));
    } finally {
      warn.mockRestore();
    }
  }

  it("warns once in dev when the route cache() entry reduces an explicit ppr window, stating what the shell gets", async () => {
    const warnings = await windowWarnings({ ttl: 300, swr: 30 }, { ttl: 60 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(
      'Route "product": its shell is stored with ttl 60 and swr 0, below its ppr.ttl 300 and ppr.swr 30. A shell never outlives the route cache() entry (ttl 60, swr 0)',
    );
  });

  it("names only the ppr value the cap reduces: a record's stale time can raise the shell's swr", async () => {
    const warnings = await windowWarnings({ ttl: 300 }, { ttl: 60, swr: 300 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(
      "its shell is stored with ttl 60 and swr 240, below its ppr.ttl 300.",
    );
  });

  it("does not warn when the cap leaves an explicit ppr window whole", async () => {
    expect(await windowWarnings({ ttl: 30, swr: 30 }, { ttl: 60 })).toEqual([]);
  });

  it("applies the cap silently when ppr sets no window", async () => {
    resetShellServeStateForTests();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await run({
        ssrModule: fullSsrModule(),
        ppr: true,
        arm: (reqCtx) => {
          (reqCtx._classifiedRoute as any).manifestEntry.cache = {
            options: { ttl: 60 },
          };
        },
      });
      expect(
        warn.mock.calls.filter(([m]) => String(m).includes("never outlives")),
      ).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("withoutShellMissMarker drops the marker from a GET and leaves other requests alone", () => {
    const marked = new Request("http://localhost/p?a=1&_rsc_shell=miss", {
      headers: { accept: "text/html", cookie: "s=1" },
    });
    const unmarked = withoutShellMissMarker(marked);
    expect(unmarked?.url).toBe("http://localhost/p?a=1");
    expect(unmarked?.headers.get("cookie")).toBe("s=1");
    expect(unmarked?.method).toBe("GET");
    expect(withoutShellMissMarker(new Request("http://localhost/p?a=1"))).toBe(
      undefined,
    );
    expect(
      withoutShellMissMarker(
        new Request("http://localhost/p?_rsc_shell=miss", {
          method: "POST",
          body: "x",
        }),
      ),
    ).toBeUndefined();
  });

  // A build shell whose tail cannot be replayed at runtime degrades like a
  // runtime entry; the tombstone it leaves must stop the next request from
  // serving (and degrading on) the same build shell again.
  describe("a runtime tombstone over a build shell", () => {
    beforeEach(() => {
      resetBuildShellManifestForTests();
      (globalThis as any).__loadShellManifestModule = async () => ({
        default: { [buildShellManifestKey("test-router", "/p")]: "/p" },
        loadShellAsset: async () => ({
          default: {
            entry: shellEntry({ docKey: undefined }),
            ttl: 300,
            routeName: "p",
          },
        }),
      });
    });
    afterEach(() => {
      delete (globalThis as any).__loadShellManifestModule;
      resetBuildShellManifestForTests();
    });

    it("control: with no runtime entry the build shell serves a HIT", async () => {
      const ssrModule = fullSsrModule();
      const { response } = await run({ ssrModule, ppr: true });
      expect(response.headers.get("x-rango-shell")).toBe("HIT");
      await readAll(response.body!);
    });

    it("a store keyGenerator returning the default key partitions nothing: the build shell still serves", async () => {
      const store = Object.assign(new MemorySegmentCacheStore(), {
        keyGenerator: (_ctx: RequestContext, defaultKey: string) => defaultKey,
      });
      const getShell = vi.spyOn(store, "getShell");
      const ssrModule = fullSsrModule();

      const { response } = await run({ ssrModule, ppr: true, store });

      expect(response.headers.get("x-rango-shell")).toBe("HIT");
      expect(getShell.mock.calls[0]?.[0]).toBe(KEY);
      await readAll(response.body!);
    });

    it("a store keyGenerator that partitions skips the build shell", async () => {
      const store = Object.assign(new MemorySegmentCacheStore(), {
        keyGenerator: (_ctx: RequestContext, defaultKey: string) =>
          `${defaultKey}|segment`,
      });
      const ssrModule = fullSsrModule();

      const { response } = await run({ ssrModule, ppr: true, store });

      expect(response.headers.get("x-rango-shell")).toBe("MISS");
      expect(ssrModule.resumeShellHTML).not.toHaveBeenCalled();
    });

    it("a partitioned request warns once, naming the route, that it skips the build shell", async () => {
      resetShellServeStateForTests();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const store = Object.assign(new MemorySegmentCacheStore(), {
        keyGenerator: (_ctx: RequestContext, defaultKey: string) =>
          `${defaultKey}|segment`,
      });
      const arm = (reqCtx: RequestContext<unknown>) => {
        (reqCtx._classifiedRoute as any).routeKey = "product";
      };
      try {
        await run({ ssrModule: fullSsrModule(), ppr: true, store, arm });
        await run({ ssrModule: fullSsrModule(), ppr: true, store, arm });
        const warnings = warn.mock.calls
          .map(([message]) => String(message))
          .filter((message) => message.includes("build-time shell"));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('Route "product" ("/p")');
        expect(warnings[0]).toContain("cache({ key })");
        expect(warnings[0]).toContain(
          "keyGenerator that returns the default key unchanged keeps the build shell",
        );
      } finally {
        warn.mockRestore();
      }
    });

    it("a param route's partitioned path without a build shell does not silence the warning for one that has it", async () => {
      resetShellServeStateForTests();
      vi.mocked(hasBuildShell).mockClear();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const store = Object.assign(new MemorySegmentCacheStore(), {
        keyGenerator: (_ctx: RequestContext, defaultKey: string) =>
          `${defaultKey}|segment`,
      });
      const arm = (reqCtx: RequestContext<unknown>) => {
        (reqCtx._classifiedRoute as any).routeKey = "product";
      };
      const serve = (url: string) =>
        run({ ssrModule: fullSsrModule(), ppr: true, store, arm, url });
      try {
        // /q has no build shell (the manifest holds /p): probed once.
        await serve("http://localhost/q");
        await serve("http://localhost/q");
        await serve("http://localhost/p");
        await serve("http://localhost/p");
        const warnings = warn.mock.calls
          .map(([message]) => String(message))
          .filter((message) => message.includes("build-time shell"));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('Route "product" ("/p")');
        expect(
          vi.mocked(hasBuildShell).mock.calls.map(([, path]) => path),
        ).toEqual(["/q", "/p"]);
      } finally {
        warn.mockRestore();
      }
    });

    it.each([
      ["composed with the inner key()", { ttl: 30, key: () => "v:a" }],
      ["inherited by an inner cache() without key()", { ttl: 30 }],
    ])(
      "a nested cache() partition (%s) skips the build shell and warns the same way (#970)",
      async (_label, inner) => {
        resetShellServeStateForTests();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const arm = (reqCtx: RequestContext<unknown>) => {
          const classified = reqCtx._classifiedRoute as any;
          classified.routeKey = "product";
          classified.manifestEntry.parent = {
            type: "cache",
            shortCode: "C0",
            parent: null,
            cache: { options: { ttl: 300, key: () => "tier:gold" } },
          };
          classified.manifestEntry.cache = { options: inner };
        };
        try {
          const { response } = await run({
            ssrModule: fullSsrModule(),
            ppr: true,
            arm,
          });
          expect(response.headers.get("x-rango-shell")).toBe("MISS");
          const warnings = warn.mock.calls
            .map(([message]) => String(message))
            .filter((message) => message.includes("build-time shell"));
          expect(warnings).toHaveLength(1);
          expect(warnings[0]).toContain('Route "product" ("/p")');
          expect(warnings[0]).toContain("a cache({ key }) enclosing the route");
        } finally {
          warn.mockRestore();
        }
      },
    );

    it("the tombstone makes the request a MISS instead of serving the build shell", async () => {
      const store = new MemorySegmentCacheStore();
      await store.putShell(
        KEY,
        {
          reactVersion: React.version,
          buildVersion: "v-test",
          snapshot: [],
          navigationOnly: true,
          createdAt: Date.now(),
        },
        300,
        0,
      );
      const ssrModule = fullSsrModule();

      const { response } = await run({ ssrModule, ppr: true, store });

      expect(response.headers.get("x-rango-shell")).toBe("MISS");
      expect(ssrModule.resumeShellHTML).not.toHaveBeenCalled();
      expect(scheduleMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe("handleRscRendering — integrated PPR serve: HIT", () => {
  // Issue #941: the integrity gate decoded the whole base64 prelude to validate
  // it and serveShellHit decoded it again, so a HIT paid two full decodes of a
  // multi-hundred-KB prelude before its first byte.
  for (const native of [false, true]) {
    it(`decodes the stored prelude once per HIT (${native ? "native fromBase64" : "atob loop"})`, async () => {
      const store = new MemorySegmentCacheStore();
      const entry = shellEntry();
      await store.putShell(KEY, entry, 300, 30);
      const decodes = spyPreludeDecodes(entry.prelude!, native);
      try {
        const { response } = await run({
          ssrModule: fullSsrModule(),
          ppr: true,
          store,
        });
        expect(response.headers.get("x-rango-shell")).toBe("HIT");
        expect(await readAll(response.body!)).toBe(
          `${PRELUDE_HTML}RESUMED-HOLE`,
        );
        expect(decodes.count()).toBe(1);
        // With the native method present, the one decode is the native one.
        if (native) expect(decodes.native()).toBe(1);
      } finally {
        decodes.restore();
      }
    });
  }

  // The chunk loop's edges: no empty chunk for an empty prelude, no short
  // trailing chunk for an exact multiple, a short last chunk for a remainder.
  for (const size of [0, 2 * 32 * 1024, 2 * 32 * 1024 + 5]) {
    it(`enqueues a ${size}-byte prelude as ${Math.ceil(size / (32 * 1024))} chunk(s)`, async () => {
      const store = new MemorySegmentCacheStore();
      await store.putShell(
        KEY,
        shellEntry({ prelude: asciiPreludeBase64(size) }),
        300,
        30,
      );
      const { response } = await run({
        ssrModule: fullSsrModule(),
        ppr: true,
        store,
      });
      expect(response.headers.get("x-rango-shell")).toBe("HIT");
      const reader = response.body!.getReader();
      const sizes: number[] = [];
      let received = 0;
      while (received < size) {
        const { value, done } = await reader.read();
        if (done) break;
        sizes.push(value.length);
        received += value.length;
      }
      reader.releaseLock();
      const full = 32 * 1024;
      const expected = Array.from({ length: Math.ceil(size / full) }, (_, i) =>
        Math.min(full, size - i * full),
      );
      expect(sizes).toEqual(expected);
      expect(await readAll(response.body!)).toBe("RESUMED-HOLE");
    });
  }

  // Issue #941: one multi-hundred-KB enqueue makes a streaming compressor
  // finish the whole prelude before its first output byte. Fixed-size chunks
  // let the first compressed bytes leave after one chunk.
  it("enqueues a large prelude in fixed-size chunks, byte-identical", async () => {
    const big = `<html><body>${"<p>shell</p>".repeat(9000)}</body></html>`;
    const bytes = new TextEncoder().encode(big);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    const store = new MemorySegmentCacheStore();
    await store.putShell(KEY, shellEntry({ prelude: btoa(binary) }), 300, 30);

    const { response } = await run({
      ssrModule: fullSsrModule(),
      ppr: true,
      store,
    });
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (received < bytes.length) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
    }
    reader.releaseLock();

    expect(chunks.length).toBe(Math.ceil(bytes.length / (32 * 1024)));
    for (const chunk of chunks)
      expect(chunk.length).toBeLessThanOrEqual(32 * 1024);
    const joined = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    expect(new TextDecoder().decode(joined)).toBe(big);
    expect(await readAll(response.body!)).toBe("RESUMED-HOLE");
  });

  // A snapshot already in memory (memory store, shell memo, build shells)
  // resolves at once. Without a macrotask between the commit and the tail's
  // work, the seed, match, and Flight render ran ahead of the runtime writing
  // the prelude (local workerd: 5.9 ms over the floor instead of 1.3 ms).
  it("starts the tail's work a macrotask after the commit when the snapshot is in memory", async () => {
    const store = new MemorySegmentCacheStore();
    await store.putShell(
      KEY,
      shellEntry({
        snapshot: [
          {
            family: "segment",
            key: "k",
            value: { segments: [], handles: "", expiresAt: 0 },
          },
        ],
      }),
      300,
      30,
    );
    const { response, ctx } = await run({
      ssrModule: fullSsrModule(),
      ppr: true,
      store,
    });
    expect(response.headers.get("x-rango-shell")).toBe("HIT");
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe(PRELUDE_HTML);
    expect(ctx.router.match).not.toHaveBeenCalled();
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toBe("RESUMED-HOLE");
    expect(ctx.router.match).toHaveBeenCalledTimes(1);
  });

  // A snapshot still arriving on I/O has yielded by the time it resolves, so
  // the tail starts at once (Node clamps setTimeout(0) to 1 ms).
  it("adds no macrotask before the tail when the snapshot arrives on I/O", async () => {
    const records: ShellSnapshotRecord[] = [
      {
        family: "segment",
        key: "k",
        value: { segments: [], handles: "", expiresAt: 0 },
      },
    ];
    const { prelude: _prelude, ...entry } = shellEntry();
    const afterSnapshot = vi.fn();
    const store = Object.assign(new MemorySegmentCacheStore(), {
      async readShellDocument(): Promise<ShellDocumentRead> {
        return {
          entry,
          prelude: new TextEncoder().encode(PRELUDE_HTML),
          shouldRevalidate: false,
          snapshot: new Promise((resolve) => {
            setTimeout(() => {
              resolve(records);
              setTimeout(afterSnapshot, 0);
            }, 5);
          }),
        };
      },
    });
    const { response, ctx } = await run({
      ssrModule: fullSsrModule(),
      ppr: true,
      store,
    });
    expect(response.headers.get("x-rango-shell")).toBe("HIT");
    expect(await readAll(response.body!)).toBe(`${PRELUDE_HTML}RESUMED-HOLE`);
    await vi.waitFor(() => expect(afterSnapshot).toHaveBeenCalledTimes(1));
    const match = ctx.router.match as ReturnType<typeof vi.fn>;
    expect(match).toHaveBeenCalledTimes(1);
    expect(match.mock.invocationCallOrder[0]).toBeLessThan(
      afterSnapshot.mock.invocationCallOrder[0]!,
    );
  });

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
      manifestEntry: { type: "route", parent: null, ppr: true },
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

  // Capture data snapshot: on a HIT the tail render replays the doc record
  // through the implicit doc scope's SeededShellStore (segments only), so the
  // payload matches the frozen prelude even after the underlying entries
  // drifted; every cache read the tail makes goes to the real store. See
  // cache/shell-snapshot.ts and docs/design/ppr-shell-resume.md.
  // Issue #941: the HIT read and parsed the whole stored entry, the capture
  // snapshot included, before its first byte. With CFCacheStore's
  // prelude-first layout the prelude flushes while the snapshot bytes are
  // still withheld, and the tail seeds from the snapshot once they arrive.
  it("flushes the prelude before the store has read the snapshot, then seeds the tail from it", async () => {
    const stored = new Map<string, { bytes: Uint8Array; init: ResponseInit }>();
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gateAt = (bytes: Uint8Array): number => bytes.length;
    const cache = {
      async match(request: Request): Promise<Response | undefined> {
        const hit = stored.get(request.url);
        if (!hit) return undefined;
        const split = gateAt(hit.bytes);
        return new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(hit.bytes.slice(0, split));
              await released;
              controller.enqueue(hit.bytes.slice(split));
              controller.close();
            },
          }),
          hit.init,
        );
      },
      async put(request: Request, response: Response): Promise<void> {
        stored.set(request.url, {
          bytes: new Uint8Array(await response.arrayBuffer()),
          init: { status: response.status, headers: response.headers },
        });
      },
      async delete(request: Request): Promise<boolean> {
        return stored.delete(request.url);
      },
    };
    vi.stubGlobal("caches", { default: cache, open: async () => cache });
    try {
      const pending: Promise<unknown>[] = [];
      const store = new CFCacheStore({
        ctx: {
          waitUntil: (p: Promise<unknown>) => {
            pending.push(p);
          },
          passThroughOnException() {},
        } as any,
      });
      const snapshot: ShellSnapshotRecord[] = [
        {
          family: "segment",
          key: "seg1",
          value: {
            segments: [],
            handles: "PINNED".repeat(1000),
            expiresAt: 0,
          },
        },
      ];
      await store.putShell(KEY, shellEntry({ snapshot }), 300, 30);
      await Promise.all(pending);
      // Withhold exactly the snapshot's bytes (they close the stored body).
      const snapshotLength = JSON.stringify(snapshot).length;
      gateAt = (bytes) => bytes.length - snapshotLength;

      const ssrModule = fullSsrModule();
      const { ctx } = makeCtx(ssrModule, "stream");
      const seen: (string | undefined)[] = [];
      (ctx as any).renderToReadableStream = () => {
        void getRequestContext()
          ._shellImplicitCache!.store!.get("seg1")
          .then((r) =>
            seen.push((r as { data?: CachedEntryData } | null)?.data?.handles),
          );
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
        manifestEntry: { type: "route", parent: null, ppr: true },
      };

      const committed = await Promise.race([
        runWithRequestContext(reqCtx, () =>
          handleRscRendering(
            ctx,
            request,
            {},
            url,
            false,
            reqCtx._handleStore,
            undefined,
          ),
        ),
        new Promise<"stalled">((resolve) =>
          setTimeout(() => resolve("stalled"), 500),
        ),
      ]);
      expect(committed).not.toBe("stalled");
      const response = committed as Response;
      expect(response.headers.get("x-rango-shell")).toBe("HIT");
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe(PRELUDE_HTML);
      expect(seen).toEqual([]);

      release();
      reader.releaseLock();
      expect(await readAll(response.body!)).toBe("RESUMED-HOLE");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(seen).toEqual(["PINNED".repeat(1000)]);
    } finally {
      release();
      vi.unstubAllGlobals();
    }
  });

  describe("CFCacheStore per-isolate shell memo", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("sends nothing on a memo hit until that request's tag-marker read resolves", async () => {
      // No marker memo: the memo hit's marker check must read KV.
      const cf = createCfShellFixture({ markerFreshMs: 0 });
      await cf.store.putShell(KEY, shellEntry(), 300, 30, ["home"]);
      await cf.drain();
      const warm = await run({
        ssrModule: fullSsrModule(),
        ppr: true,
        store: cf.store,
      });
      expect(warm.response.headers.get("x-rango-shell")).toBe("HIT");
      await readAll(warm.response.body!);
      const matchesAfterWarm = cf.counts.matches;

      const release = cf.holdMarkerReads();
      let committed = false;
      const pending = run({
        ssrModule: fullSsrModule(),
        ppr: true,
        store: cf.store,
      }).then((result) => {
        committed = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(committed).toBe(false);

      release();
      const { response } = await pending;
      expect(response.headers.get("x-rango-shell")).toBe("HIT");
      expect(await readAll(response.body!)).toBe(`${PRELUDE_HTML}RESUMED-HOLE`);
      // Served from the memo: no Cache API read on the second request.
      expect(cf.counts.matches).toBe(matchesAfterWarm);
    });

    // A doc record that fails to decode on a HIT schedules a recapture (#958).
    // The memoized copy holds the same record, so the recapture also drops
    // it: the next HIT reads the store, which may already hold another
    // isolate's recapture, instead of the memo for the rest of its window.
    // The isolate marker memo serves PPR shell reads only (issue #941). A MISS
    // request's hinted shell read may answer "T" from it, up to
    // markerMaxStaleMs old; the foreground render must still read its "use
    // cache" data under the store's marker, or it would store the stale item
    // inside a new cache() segment written after the invalidation.
    it("a MISS foreground render reads its tagged data fresh, not under the shell read's memoized marker", async () => {
      const cf = createCfShellFixture();
      const inRequest = <R>(fn: () => Promise<R>): Promise<R> =>
        runWithRequestContext(
          createRequestContext({
            env: {},
            request: new Request("http://localhost/q"),
            url: new URL("http://localhost/q"),
            variables: {},
          }),
          fn,
        );
      await inRequest(() =>
        cf.store.setItem("item", "GEN1", { ttl: 300, tags: ["T"] }),
      );
      await cf.drain();
      const url = "http://localhost/q";
      const ppr = { ttl: 300, tags: ["T"] };
      // This isolate memoizes marker "T" through a MISS whose route hints it.
      const warm = await run({
        ssrModule: fullSsrModule(),
        ppr,
        store: cf.store,
        url,
      });
      expect(warm.response.headers.get("x-rango-shell")).toBe("MISS");
      await readAll(warm.response.body!);
      await cf.drain();
      // Another isolate invalidates "T".
      vi.resetModules();
      const { CFCacheStore: IsolateA } =
        await import("../../cache/cf/cf-cache-store.js");
      await new IsolateA({
        ctx: { waitUntil() {}, passThroughOnException() {} } as any,
        kv: cf.kv as any,
      }).invalidateTags(["T"]);
      await new Promise((resolve) => setTimeout(resolve, 5));
      // The foreground render of a MISS: a cache() segment that reads the
      // item and is stored with the render's tags.
      const router = {
        ...makeCtx(fullSsrModule(), "stream").ctx.router,
        match: vi.fn(async () => {
          const store = getRequestContext()._cacheStore!;
          const item = await store.getItem!("item");
          await store.set(
            "seg",
            {
              segments: [],
              handles: item?.value ?? "GEN2",
              expiresAt: 0,
              tags: ["T"],
            },
            300,
          );
          return { redirect: undefined, ...emptyMatchResult() };
        }),
      } as unknown as HandlerContext<unknown>["router"];
      const miss = await run({
        ssrModule: fullSsrModule(),
        ppr,
        store: cf.store,
        url,
        router,
      });
      expect(miss.response.headers.get("x-rango-shell")).toBe("MISS");
      await readAll(miss.response.body!);
      await cf.drain();
      const segment = await inRequest(() => cf.store.get("seg"));
      expect(
        segment && typeof segment === "object" && "data" in segment
          ? segment.data.handles
          : segment,
      ).toBe("GEN2");
      vi.resetModules();
    });

    // A partial navigation's replay gate reads the shell (getShell) on the
    // same request context its matchPartial then renders on. The shell read
    // may be served under a memoized marker (other users' staleness, up to
    // markerMaxStaleMs); the render's data reads must not inherit it, or a
    // cache() segment it writes keeps the stale item under a fresh taggedAt,
    // past markerMaxStaleMs, until its TTL.
    it("a partial navigation's render reads its tagged data fresh after the replay gate's shell HIT", async () => {
      const cf = createCfShellFixture();
      const inRequest = <R>(fn: () => Promise<R>): Promise<R> =>
        runWithRequestContext(
          createRequestContext({
            env: {},
            request: new Request("http://localhost/p"),
            url: new URL("http://localhost/p"),
            variables: {},
          }),
          fn,
        );
      const ppr = { ttl: 300, tags: ["T"] };
      await cf.store.putShell(KEY, shellEntry(), 300, 30, ["T"]);
      await inRequest(() =>
        cf.store.setItem("item", "GEN1", { ttl: 300, tags: ["T"] }),
      );
      await cf.drain();
      // A document HIT memoizes marker "T" (none yet) in this isolate.
      const warm = await run({
        ssrModule: fullSsrModule(),
        ppr,
        store: cf.store,
      });
      expect(warm.response.headers.get("x-rango-shell")).toBe("HIT");
      await readAll(warm.response.body!);
      await cf.drain();
      await new Promise((resolve) => setTimeout(resolve, 5));
      // Another isolate invalidates "T".
      vi.resetModules();
      const { CFCacheStore: IsolateA } =
        await import("../../cache/cf/cf-cache-store.js");
      await new IsolateA({
        ctx: { waitUntil() {}, passThroughOnException() {} } as any,
        kv: cf.kv as any,
      }).invalidateTags(["T"]);
      await new Promise((resolve) => setTimeout(resolve, 5));

      const shellReads = vi.spyOn(cf.store, "getShell");
      const seen: unknown[] = [];
      const partial = await run({
        ssrModule: fullSsrModule(),
        ppr,
        store: cf.store,
        partial: true,
        matchPartial: (async () => {
          const store = getRequestContext()._cacheStore!;
          const item = await store.getItem!("item");
          seen.push(item?.value ?? null);
          await store.set(
            "seg",
            {
              segments: [],
              handles: item?.value ?? "GEN2",
              expiresAt: 0,
              tags: ["T"],
            },
            300,
          );
          return emptyMatchResult();
        }) as any,
      });
      expect(partial.response.status).toBe(200);
      await cf.drain();
      // The gate's shell read was served from the memos (its marker is stale).
      const gate = await Promise.all(
        shellReads.mock.results.map((result) => result.value),
      );
      expect(gate.some((read) => read !== null)).toBe(true);
      // The render's data read went to KV.
      expect(seen).toEqual([null]);
      const segment = await inRequest(() => cf.store.get("seg"));
      expect(
        segment && typeof segment === "object" && "data" in segment
          ? segment.data.handles
          : segment,
      ).toBe("GEN2");
      vi.resetModules();
    });

    it("a doc record the tail cannot replay tombstones the entry, drops the memo, recaptures, and reloads into a MISS", async () => {
      const cf = createCfShellFixture();
      await cf.store.putShell(KEY, shellEntry(), 300, 30);
      await cf.drain();
      const router = {
        ...makeCtx(fullSsrModule(), "stream").ctx.router,
        // What withCacheLookup throws when the doc record does not hit.
        match: vi.fn(async () => {
          throw new ShellRecordUnavailableError("doc:localhost/p");
        }),
      } as unknown as HandlerContext<unknown>["router"];

      const first = await run({
        ssrModule: fullSsrModule(),
        ppr: true,
        store: cf.store,
        router,
      });
      expect(first.response.headers.get("x-rango-shell")).toBe("HIT");
      const body = await readAll(first.response.body!);
      // The prelude already committed; the tail ends with a reload, and no
      // handler ran (the only match call threw).
      expect(body.startsWith(PRELUDE_HTML)).toBe(true);
      expect(body).toContain(shellReloadScript());
      expect(scheduleMock).toHaveBeenCalledTimes(1);
      await cf.drain();

      // The tombstone makes the reload a MISS, read past the dropped memo.
      const matchesBefore = cf.counts.matches;
      const second = await run({
        ssrModule: fullSsrModule(),
        ppr: true,
        store: cf.store,
      });
      expect(second.response.headers.get("x-rango-shell")).toBe("MISS");
      await readAll(second.response.body!);
      expect(cf.counts.matches).toBe(matchesBefore + 1);
    });

    it.each([
      ["unavailable", false],
      ["corrupt", true],
    ] as const)(
      "a snapshot read that failed as %s reloads into a forced MISS; only a broken entry is replaced",
      async (failure, replaced) => {
        const store = new MemorySegmentCacheStore();
        await store.putShell(KEY, shellEntry(), 300, 30);
        const { entry } = (await store.getShell(KEY))!;
        const dropShellMemo = vi.fn();
        Object.assign(store, {
          // A prelude-first read whose snapshot did not arrive.
          async readShellDocument(): Promise<ShellDocumentRead> {
            return {
              entry,
              prelude: new TextEncoder().encode(PRELUDE_HTML),
              snapshot: Promise.resolve(undefined),
              snapshotFailure: Promise.resolve(failure),
            };
          },
          dropShellMemo,
        });
        const putShell = vi.spyOn(store, "putShell");
        const router = {
          ...makeCtx(fullSsrModule(), "stream").ctx.router,
          match: vi.fn(async () => {
            throw new ShellRecordUnavailableError("doc:localhost/p");
          }),
        } as unknown as HandlerContext<unknown>["router"];

        const { response } = await run({
          ssrModule: fullSsrModule(),
          ppr: true,
          store,
          router,
        });
        expect(response.headers.get("x-rango-shell")).toBe("HIT");
        const body = await readAll(response.body!);
        expect(body.startsWith(PRELUDE_HTML)).toBe(true);
        expect(body).toContain(shellReloadScript());

        if (replaced) {
          expect(putShell).toHaveBeenCalledTimes(1);
          expect(putShell.mock.calls[0]![1]).toMatchObject({
            navigationOnly: true,
          });
          expect(dropShellMemo).toHaveBeenCalledWith(KEY);
          expect(scheduleMock).toHaveBeenCalledTimes(1);
        } else {
          // A slow read is not a broken entry: no tombstone, no memo drop,
          // no recapture; the next request reads the same entry again.
          expect(putShell).not.toHaveBeenCalled();
          expect(dropShellMemo).not.toHaveBeenCalled();
          expect(scheduleMock).not.toHaveBeenCalled();
          expect((await store.getShell(KEY))?.entry.docKey).toBe(
            "doc:localhost/p",
          );
        }
      },
    );

    /** The rows of one HIT under debugPerformance, by label. */
    async function hitRows(
      store: CFCacheStore,
      arm?: (reqCtx: RequestContext<unknown>) => void,
    ): Promise<Map<string, string | undefined>> {
      let metrics: MetricsStore | undefined;
      const { response } = await run({
        ssrModule: fullSsrModule(),
        ppr: true,
        store,
        arm: (reqCtx) => {
          metrics = createMetricsStore(true);
          reqCtx._metricsStore = metrics;
          arm?.(reqCtx);
        },
      });
      expect(response.headers.get("x-rango-shell")).toBe("HIT");
      await readAll(response.body!);
      return new Map(metrics!.metrics.map((m) => [m.label, m.desc]));
    }

    it("reports a stale-served marker (refreshing), then a fresh one, on memo hits", async () => {
      const cf = createCfShellFixture({ markerFreshMs: 50 });
      await cf.store.putShell(KEY, shellEntry(), 300, 30, ["home"]);
      await cf.drain();
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await hitRows(cf.store);
        await new Promise((resolve) => setTimeout(resolve, 60));
        const stale = await hitRows(cf.store);
        expect(stale.get("ppr:shell-read")).toBe("hit memo");
        expect(stale.get("ppr:shell-marker")).toMatch(/ memo=stale\b/);
        await cf.drain(); // the background refresh
        const fresh = await hitRows(cf.store);
        expect(fresh.get("ppr:shell-marker")).toMatch(/ memo=fresh\b/);
      } finally {
        log.mockRestore();
      }
    });

    it("reports a fresh-reads request's store read and bypassed marker memo", async () => {
      const cf = createCfShellFixture();
      await cf.store.putShell(KEY, shellEntry(), 300, 30, ["home"]);
      await cf.drain();
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await hitRows(cf.store); // fills both memos
        const bypass = await hitRows(cf.store, (reqCtx) => {
          reqCtx._freshReads = true;
        });
        expect(bypass.get("ppr:shell-read")).toBe("hit l1");
        expect(bypass.has("ppr:shell-memo")).toBe(true);
        expect(bypass.get("ppr:shell-marker")).toMatch(
          / memo=bypass .*fresh-reads$/,
        );
      } finally {
        log.mockRestore();
      }
    });

    it("reports the memo outcome and size under debugPerformance", async () => {
      const cf = createCfShellFixture();
      await cf.store.putShell(KEY, shellEntry(), 300, 30);
      await cf.drain();
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const rowsOf = async () => {
          let metrics: MetricsStore | undefined;
          const { response } = await run({
            ssrModule: fullSsrModule(),
            ppr: true,
            store: cf.store,
            arm: (reqCtx) => {
              metrics = createMetricsStore(true);
              reqCtx._metricsStore = metrics;
            },
          });
          await readAll(response.body!);
          return new Map(metrics!.metrics.map((m) => [m.label, m.desc]));
        };
        const first = await rowsOf();
        expect(first.get("ppr:shell-read")).toBe("hit l1");
        expect(first.get("ppr:shell-memo")).toBe("miss size=0b");
        const second = await rowsOf();
        expect(second.get("ppr:shell-read")).toBe("hit memo");
        expect(second.get("ppr:shell-memo")).toBe(
          `hit size=${PRELUDE_HTML.length}b`,
        );
        expect(second.get("ppr:shell-marker")).toMatch(/^tags=0 parallel/);
        expect(second.has("ppr:shell-match")).toBe(false);
      } finally {
        log.mockRestore();
      }
    });

    // VercelCacheStore reads the whole entry (no prelude-first read), then its
    // tag markers: the rows name the single tier and a serial marker read.
    it("reports VercelCacheStore's store read, then its memo hit", async () => {
      const backing = new Map<string, unknown>();
      const store = new VercelCacheStore({
        cache: {
          async get(key) {
            const value = backing.get(key);
            return value === undefined
              ? undefined
              : JSON.parse(JSON.stringify(value));
          },
          async set(key, value) {
            backing.set(key, JSON.parse(JSON.stringify(value)));
          },
          async delete(key) {
            backing.delete(key);
          },
          async expireTag() {},
        },
      });
      await store.putShell(KEY, shellEntry(), 300, 30, ["home"]);
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const rowsOf = async () => {
          let metrics: MetricsStore | undefined;
          const { response } = await run({
            ssrModule: fullSsrModule(),
            ppr: true,
            store: store as any,
            arm: (reqCtx) => {
              metrics = createMetricsStore(true);
              reqCtx._metricsStore = metrics;
            },
          });
          expect(response.headers.get("x-rango-shell")).toBe("HIT");
          expect(await readAll(response.body!)).toBe(
            `${PRELUDE_HTML}RESUMED-HOLE`,
          );
          return new Map(metrics!.metrics.map((m) => [m.label, m.desc]));
        };
        const first = await rowsOf();
        expect(first.get("ppr:shell-read")).toBe("hit store");
        expect(first.get("ppr:shell-memo")).toMatch(/^miss size=\d+b$/);
        expect(first.get("ppr:shell-match")).toBe("store");
        expect(first.get("ppr:shell-marker")).toMatch(/^tags=1 serial /);
        expect(first.get("ppr:shell-open")).toBe(
          `cpu raw prelude=${PRELUDE_HTML.length}b`,
        );
        const second = await rowsOf();
        expect(second.get("ppr:shell-read")).toBe("hit memo");
        expect(second.get("ppr:shell-memo")).toMatch(/^hit size=\d+b$/);
        expect(second.get("ppr:shell-marker")).toMatch(/^tags=1 serial /);
        expect(second.has("ppr:shell-match")).toBe(false);
      } finally {
        log.mockRestore();
      }
    });

    it("never serves a memoized shell captured by another build", async () => {
      const cf = createCfShellFixture();
      await cf.store.putShell(
        KEY,
        shellEntry({ buildVersion: "old-build" }),
        300,
        30,
      );
      await cf.drain();
      for (let i = 0; i < 2; i++) {
        const { response } = await run({
          ssrModule: fullSsrModule(),
          ppr: true,
          store: cf.store,
        });
        expect(response.headers.get("x-rango-shell")).toBe("MISS");
        await readAll(response.body!);
      }
    });
  });

  it("the tail render's cache reads go to the store: an item record in the snapshot (an entry stored before holes read live) is not served", async () => {
    const store = new MemorySegmentCacheStore();
    await store.setItem("it1", "LIVE", { ttl: 60 });
    const snapshot = [
      { family: "item", key: "it1", value: { value: "PINNED-AT-CAPTURE" } },
    ] as unknown as ShellSnapshotRecord[];
    await store.putShell(KEY, shellEntry({ snapshot }), 300, 30);
    const getItemSpy = vi.spyOn(store, "getItem");

    const ssrModule = fullSsrModule();
    const { ctx } = makeCtx(ssrModule, "stream");
    const reads: Promise<unknown>[] = [];
    const seen: (string | undefined)[] = [];
    (ctx as any).renderToReadableStream = () => {
      // A cache read during the tail render (a hole's, a bake-lane loader
      // body's that runs on the HIT) reads the store, not the capture.
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
      manifestEntry: { type: "route", parent: null, ppr: true },
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

    expect(seen).toEqual(["LIVE"]);
    expect(getItemSpy).toHaveBeenCalledWith("it1");
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
      manifestEntry: { type: "route", parent: null, ppr: true },
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
        ? [
            {
              family: "segment",
              key: "k",
              value: { segments: [], handles: "", expiresAt: 0 },
            },
          ]
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
        manifestEntry: { type: "route", parent: null, ppr: true },
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
    // Captured 2 s ago: past the minimum recapture interval.
    await store.putShell(
      KEY,
      shellEntry({ createdAt: Date.now() - 2_000 }),
      0,
      300,
    );
    await new Promise((r) => setTimeout(r, 5));
    const ssrModule = fullSsrModule();

    const { response } = await run({ ssrModule, ppr: true, store });

    expect(response.headers.get("x-rango-shell")).toBe("HIT");
    expect(await readAll(response.body!)).toBe(`${PRELUDE_HTML}RESUMED-HOLE`);
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect((scheduleMock.mock.calls[0]![6] as any).key).toBe(KEY);
  });

  it("a stale hit inside the minimum recapture interval serves the stale shell without scheduling a recapture", async () => {
    const store = new MemorySegmentCacheStore();
    await store.putShell(KEY, shellEntry(), 0, 300);
    await new Promise((r) => setTimeout(r, 5));

    const { response } = await run({
      ssrModule: fullSsrModule(),
      ppr: true,
      store,
    });

    expect(response.headers.get("x-rango-shell")).toBe("HIT");
    await readAll(response.body!);
    expect(scheduleMock).not.toHaveBeenCalled();
  });
});

/**
 * A CFCacheStore over Map-backed Cache API and KV stubs (caches is stubbed),
 * starting from an empty per-isolate shell memo. `counts.matches` counts
 * Cache API reads; `holdMarkerReads` gates the KV tag-marker reads.
 */
function createCfShellFixture(memo?: StoreMemoOptions) {
  resetCFShellMemoForTests();
  const stored = new Map<string, { bytes: Uint8Array; init: ResponseInit }>();
  const counts = { matches: 0 };
  const l1 = { matchDelayMs: 0 };
  const cache = {
    async match(request: Request): Promise<Response | undefined> {
      counts.matches++;
      if (l1.matchDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, l1.matchDelayMs));
      }
      const hit = stored.get(request.url);
      return hit ? new Response(hit.bytes.slice(), hit.init) : undefined;
    },
    async put(request: Request, response: Response): Promise<void> {
      stored.set(request.url, {
        bytes: new Uint8Array(await response.arrayBuffer()),
        init: { status: response.status, headers: response.headers },
      });
    },
    async delete(request: Request): Promise<boolean> {
      return stored.delete(request.url);
    },
  };
  const kvValues = new Map<string, string>();
  let gate: Promise<void> | undefined;
  const kv = {
    async get(key: string): Promise<string | null> {
      if (gate && key.includes("__tag__/")) await gate;
      return kvValues.get(key) ?? null;
    },
    async put(key: string, value: string): Promise<void> {
      kvValues.set(key, value);
    },
    async delete(key: string): Promise<void> {
      kvValues.delete(key);
    },
  };
  vi.stubGlobal("caches", { default: cache, open: async () => cache });
  const pending: Promise<unknown>[] = [];
  const store = new CFCacheStore({
    ctx: {
      waitUntil: (p: Promise<unknown>) => {
        pending.push(p);
      },
      passThroughOnException() {},
    } as any,
    kv: kv as any,
    memo,
  });
  return {
    store,
    kv,
    counts,
    drain: () => Promise.all(pending.splice(0)),
    /** Empty the Cache API tier (KV keeps its copy); delay its match. */
    l1MissFor(ms: number): void {
      stored.clear();
      l1.matchDelayMs = ms;
    },
    holdMarkerReads(): () => void {
      let release!: () => void;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

// Issue #941: the HIT's store read, integrity check, and prelude flush were
// one `ppr:shell-read` number, and the snapshot work after the commit was
// invisible. Under debugPerformance each sub-step is its own row, with the
// byte counts that expose the cost where workerd's clock does not advance.
describe("handleRscRendering — integrated PPR serve: debugPerformance rows", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("records the read, marker, open, and commit rows with sizes and counts", async () => {
    const cf = createCfShellFixture();
    const snapshot: ShellSnapshotRecord[] = [
      {
        family: "segment",
        key: "seg1",
        value: { segments: [], handles: "PINNED", expiresAt: 0 },
      },
      {
        family: "segment",
        key: "seg2",
        value: { segments: [], handles: "PINNED", expiresAt: 0 },
      },
      {
        family: "segment",
        key: "doc:none",
        value: { segments: [], handles: "", expiresAt: 0 },
      },
    ];
    await cf.store.putShell(KEY, shellEntry({ snapshot }), 300, 30, ["home"]);
    await cf.drain();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let metrics: MetricsStore | undefined;
    try {
      const { response } = await run({
        ssrModule: fullSsrModule(),
        ppr: true,
        store: cf.store,
        arm: (reqCtx) => {
          metrics = createMetricsStore(true);
          reqCtx._metricsStore = metrics;
        },
      });
      expect(response.headers.get("x-rango-shell")).toBe("HIT");
      const rows = new Map(
        metrics!.metrics.map((m) => [
          m.label,
          { depth: m.depth, desc: m.desc },
        ]),
      );
      const preludeLength = PRELUDE_HTML.length;
      expect(rows.get("ppr:shell-read")).toEqual({
        depth: undefined,
        desc: "hit l1",
      });
      expect(rows.get("ppr:shell-match")).toEqual({ depth: 1, desc: "l1" });
      expect(rows.get("ppr:shell-head")?.desc).toMatch(/^bytes=\d+$/);
      expect(rows.get("ppr:shell-prelude")?.desc).toBe(
        `bytes=${preludeLength}`,
      );
      // The HIT's first marker read goes to KV (putShell's generation check
      // reads KV directly, not through the isolate marker memo); putShell
      // remembered the shell's tag, so that read started before the head.
      expect(rows.get("ppr:shell-marker")?.desc).toMatch(
        /^tags=1 parallel commit-wait=\d+\.\d\dms memo=read hint=1\/1 lead=\d+\.\d\dms$/,
      );
      expect(rows.get("ppr:shell-open")?.desc).toBe(
        `cpu raw prelude=${preludeLength}b`,
      );
      expect(rows.get("ppr:shell-commit")?.desc).toBe(
        `cpu chunks=1 prelude=${preludeLength}b`,
      );
      expect(rows.has("ppr:shell-l1-miss")).toBe(false);

      await readAll(response.body!);
      const tail = log.mock.calls
        .map(([line]) => String(line))
        .find((line) => line.startsWith("[RSC Perf] GET /p shell tail:"));
      expect(tail).toMatch(
        /snapshot=\d+ms snapshot-read=\d+ms snapshot-bytes=\d+b snapshot-parse-cpu=\d+ms records=segment:3 seed=\d+ms seed-cpu=\d+ms /,
      );
    } finally {
      log.mockRestore();
    }
  });

  // A KV hit after an L1 miss: the L1 attempt is its own row, and the KV
  // read's rows start after it instead of at the read's start.
  it("puts the L1 attempt ahead of a KV hit's rows", async () => {
    vi.useRealTimers();
    const cf = createCfShellFixture();
    await cf.store.putShell(KEY, shellEntry(), 300, 30);
    await cf.drain();
    cf.l1MissFor(15);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let metrics: MetricsStore | undefined;
    try {
      const { response } = await run({
        ssrModule: fullSsrModule(),
        ppr: true,
        store: cf.store,
        arm: (reqCtx) => {
          metrics = createMetricsStore(true);
          reqCtx._metricsStore = metrics;
        },
      });
      expect(response.headers.get("x-rango-shell")).toBe("HIT");
      await readAll(response.body!);
      const rows = new Map(metrics!.metrics.map((m) => [m.label, m]));
      expect(rows.get("ppr:shell-read")?.desc).toBe("hit kv");
      const l1Miss = rows.get("ppr:shell-l1-miss")!;
      expect(l1Miss).toMatchObject({ depth: 1, desc: "absent" });
      expect(l1Miss.duration).toBeGreaterThanOrEqual(14);
      const match = rows.get("ppr:shell-match")!;
      expect(match.desc).toBe("kv");
      expect(match.startTime).toBeGreaterThanOrEqual(
        l1Miss.startTime + l1Miss.duration - 0.001,
      );
      expect(rows.get("ppr:shell-prelude")!.startTime).toBeGreaterThanOrEqual(
        match.startTime + match.duration - 0.001,
      );
    } finally {
      log.mockRestore();
    }
  });

  it("takes no read timestamps, allocates no read stats, and logs nothing when debugPerformance is off", async () => {
    vi.stubEnv("NODE_ENV", "production");
    takeShellTailTimingForServerTiming(KEY); // an earlier test's buffered tail
    const cf = createCfShellFixture();
    await cf.store.putShell(KEY, shellEntry(), 300, 30);
    await cf.drain();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const now = vi.spyOn(performance, "now");
    const readShellDocument = cf.store.readShellDocument.bind(cf.store);
    let readTimestamps = -1;
    let read: Awaited<ReturnType<typeof readShellDocument>> | undefined;
    vi.spyOn(cf.store, "readShellDocument").mockImplementation(async (key) => {
      const before = now.mock.calls.length;
      read = await readShellDocument(key);
      readTimestamps = now.mock.calls.length - before;
      return read;
    });
    try {
      const { response } = await run({
        ssrModule: fullSsrModule(),
        ppr: true,
        store: cf.store,
      });
      await readAll(response.body!);
      expect(readTimestamps).toBe(0);
      expect(read).not.toBeNull();
      expect("stats" in read!).toBe(false);
      expect(takeShellTailTimingForServerTiming(KEY)).toBeUndefined();
      expect(
        log.mock.calls.some(([line]) => String(line).startsWith("[RSC Perf]")),
      ).toBe(false);
    } finally {
      log.mockRestore();
      now.mockRestore();
    }
  });

  it("in production, buffers a tail timing only for a HIT that collected metrics", async () => {
    vi.stubEnv("NODE_ENV", "production");
    takeShellTailTimingForServerTiming(KEY); // an earlier test's buffered tail
    const cf = createCfShellFixture();
    await cf.store.putShell(KEY, shellEntry(), 300, 30);
    await cf.drain();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const off = await run({
        ssrModule: fullSsrModule(),
        ppr: true,
        store: cf.store,
      });
      await readAll(off.response.body!);
      expect(takeShellTailTimingForServerTiming(KEY)).toBeUndefined();

      const on = await run({
        ssrModule: fullSsrModule(),
        ppr: true,
        store: cf.store,
        arm: (reqCtx) => {
          reqCtx._metricsStore = createMetricsStore(true);
        },
      });
      await readAll(on.response.body!);
      expect(takeShellTailTimingForServerTiming(KEY)?.outcome).toBe("complete");
    } finally {
      log.mockRestore();
    }
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
    await store.putShell(
      "test-router@tenant-a.example/page:shell",
      shellEntry(),
      300,
      30,
    );
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
      "test-router@tenant-b.example/page:shell",
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

  // A partitioned route's partial replay reads the visitor's own partition,
  // never the unpartitioned key or another partition's.
  it("replays from the visitor's own partition when the route cache() has key()", async () => {
    const store = new MemorySegmentCacheStore();
    const silverKey = partitionShellKey(KEY, composeCacheKeys(["tier:silver"]));
    await store.putShell(
      partitionShellKey(KEY, composeCacheKeys(["tier:gold"])),
      shellEntry({ snapshot: [segmentRecord], docKey: DOC_KEY }),
      300,
    );
    await store.putShell(
      silverKey,
      shellEntry({ snapshot: [segmentRecord], docKey: DOC_KEY }),
      300,
    );
    const getShell = vi.spyOn(store, "getShell");

    const { response } = await run({
      ssrModule: fullSsrModule(),
      partial: true,
      ppr: true,
      store,
      headers: { "x-tier": "silver" },
      arm: (reqCtx) => {
        (reqCtx._classifiedRoute as any).manifestEntry.cache = {
          options: {
            ttl: 30,
            key: (ctx: RequestContext) =>
              `tier:${ctx.request.headers.get("x-tier")}`,
          },
        };
      },
      matchPartial: async () => {
        const active = getRequestContext();
        if ((await active._shellImplicitCache?.store?.get(DOC_KEY)) !== null) {
          active._shellImplicitCache?.onHit?.();
        }
        return emptyMatchResult();
      },
    });

    expect(response.headers.get("x-rango-ppr-replay")).toBe(
      "HIT; freshness=fresh",
    );
    expect(getShell.mock.calls.map(([key]) => key)).toEqual([silverKey]);
  });

  it("passively replays a stale shell without claiming revalidation ownership", async () => {
    const store = new MemorySegmentCacheStore();
    const getShell = vi.spyOn(store, "getShell").mockResolvedValue({
      entry: shellEntry({ snapshot: [segmentRecord], docKey: DOC_KEY }),
      shouldRevalidate: true,
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

  // Replay never serves the prelude, so an undecodable one does not decline
  // it; the document path rejects that entry (MISS + recapture), which
  // rewrites the snapshot too.
  it("replays the snapshot of a document entry whose prelude does not decode", async () => {
    const { response } = await run({
      ssrModule: fullSsrModule(),
      partial: true,
      ppr: true,
      shell: shellEntry({
        prelude: "%%%",
        snapshot: [segmentRecord],
        docKey: DOC_KEY,
      }),
      matchPartial: async () => {
        const active = getRequestContext();
        if ((await active._shellImplicitCache?.store?.get(DOC_KEY)) !== null) {
          active._shellImplicitCache?.onHit?.();
        }
        return emptyMatchResult();
      },
    });
    expect(response.headers.get("x-rango-ppr-replay")).toBe(
      "HIT; freshness=fresh",
    );
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  // Issue #941: partial replay consumes only the snapshot, yet its gate
  // decoded the document entry's whole prelude on every navigation.
  for (const native of [false, true]) {
    it(`replays a document snapshot without decoding its prelude (${native ? "native fromBase64" : "atob loop"})`, async () => {
      const entry = shellEntry({ snapshot: [segmentRecord], docKey: DOC_KEY });
      const decodes = spyPreludeDecodes(entry.prelude!, native);
      try {
        const { response } = await run({
          ssrModule: fullSsrModule(),
          partial: true,
          ppr: true,
          shell: entry,
          matchPartial: async () => {
            const active = getRequestContext();
            if (
              (await active._shellImplicitCache?.store?.get(DOC_KEY)) !== null
            ) {
              active._shellImplicitCache?.onHit?.();
            }
            return emptyMatchResult();
          },
        });
        expect(response.headers.get("x-rango-ppr-replay")).toBe(
          "HIT; freshness=fresh",
        );
        expect(decodes.count()).toBe(0);
      } finally {
        decodes.restore();
      }
    });
  }

  it("seeds the captured document segments; item reads go to the store", async () => {
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
        snapshot: [segmentRecord],
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
        expect("getItem" in replayStore).toBe(false);
        itemValue = (await active._cacheStore!.getItem!("loader-item"))?.value;
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
    ["an unparseable postponed blob", { postponed: "{" }, "corrupt-entry"],
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

  it("replays a slim navigation snapshot (no stored document half)", async () => {
    // The write path drops prelude/postponed on navigationOnly entries — the
    // payload integrity gate must not apply to them, and replay must stay
    // eligible from snapshot/docKey alone.
    const store = new MemorySegmentCacheStore();
    const slim = shellEntry({
      navigationOnly: true,
      snapshot: [segmentRecord],
      docKey: DOC_KEY,
    });
    delete slim.prelude;
    delete slim.postponed;
    await store.putShell(NAVIGATION_KEY, slim, 300);
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

  describe("the bake-lane loader seed", () => {
    const loaderRecord: ShellSnapshotRecord = {
      family: "loader",
      key: "R0D0.app/x#Plain",
      value: { value: "{}", holes: 0, runs: 0 },
    };
    const seed = new Map<string, ShellLoaderSeedEntry>([
      [
        "app/x#Plain",
        { container: { plain: 1 }, holes: false, runs: false, complete: true },
      ],
    ]);

    it("is decoded only when the replay hits the doc record, and armed for the match", async () => {
      vi.mocked(buildShellLoaderSeed).mockResolvedValue(seed);
      let armed: unknown;
      const { response } = await run({
        ssrModule: fullSsrModule(),
        partial: true,
        ppr: true,
        shell: shellEntry({
          snapshot: [segmentRecord, loaderRecord],
          docKey: DOC_KEY,
        }),
        matchPartial: async () => {
          const active = getRequestContext();
          expect(buildShellLoaderSeed).not.toHaveBeenCalled();
          await active._shellImplicitCache?.onHit?.();
          armed = active._shellLoaderSeed;
          return emptyMatchResult();
        },
      });

      expect(response.headers.get("x-rango-ppr-replay")).toBe(
        "HIT; freshness=fresh",
      );
      expect(buildShellLoaderSeed).toHaveBeenCalledTimes(1);
      expect(armed).toBe(seed);
    });

    it("is not decoded when the explicit tier supplies the match", async () => {
      vi.mocked(buildShellLoaderSeed).mockResolvedValue(seed);
      const { response } = await run({
        ssrModule: fullSsrModule(),
        partial: true,
        ppr: true,
        shell: shellEntry({
          snapshot: [segmentRecord, loaderRecord],
          docKey: DOC_KEY,
        }),
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
      expect(buildShellLoaderSeed).not.toHaveBeenCalled();
    });
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

// A router.prerender() warm through the shell serve path (shellServePlan).
// The handler puts the warm's record on the request context
// (RequestContext._prerenderWarm, prerender/warm-request.ts). In `replace`
// mode the request renders without reading a shell and its capture is forced;
// in `fill` mode (`onlyIfStale`) it reads as a visitor's request does and the
// record only reports. docs/design/prerender-every-route.md, "PPR document
// shell".
describe("handleRscRendering — integrated PPR serve: a router.prerender() warm", () => {
  /** A warm's record, and the `arm` that puts it on the request context. */
  function warm(
    mode: PrerenderWarmRecord["mode"],
    also?: (reqCtx: RequestContext<unknown>) => void,
  ) {
    const record = createWarmRecord(mode, {
      store: new MemorySegmentCacheStore(),
    });
    const arm = (reqCtx: RequestContext<unknown>): void => {
      reqCtx._prerenderWarm = record;
      also?.(reqCtx);
    };
    return { record, arm };
  }

  /** The descriptor of the one capture the request scheduled. */
  function scheduledDescriptor() {
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    return scheduleMock.mock.calls[0]![6];
  }

  const partitionedStore = () =>
    Object.assign(new MemorySegmentCacheStore(), {
      keyGenerator: (_ctx: RequestContext, defaultKey: string) =>
        `${defaultKey}|segment`,
    });

  describe("replace mode", () => {
    it("does not read a stored shell: the request is a MISS and its capture is forced", async () => {
      const store = new MemorySegmentCacheStore();
      await store.putShell(KEY, shellEntry(), 300, 30);
      const getShell = vi.spyOn(store, "getShell");
      const ssrModule = fullSsrModule();
      const { record, arm } = warm("replace");

      const { response } = await run({ ssrModule, ppr: true, store, arm });

      expect(getShell).not.toHaveBeenCalled();
      expect(response.headers.get("x-rango-shell")).toBe("MISS");
      expect(ssrModule.renderHTML).toHaveBeenCalledTimes(1);
      expect(ssrModule.resumeShellHTML).not.toHaveBeenCalled();
      const descriptor = scheduledDescriptor();
      expect(descriptor.key).toBe(KEY);
      expect(descriptor.store).toBe(store);
      expect(descriptor.force).toBe(true);
      // No sequence: a capture another request stored meanwhile must not
      // cancel the warm's own (skip-stored).
      expect(descriptor.storedSeqAtRead).toBeUndefined();
      // Stands until the capture reports.
      expect(record.shell).toBe("not-eligible");

      // Control: a visitor's request serves that entry.
      scheduleMock.mockClear();
      const visitor = await run({
        ssrModule: fullSsrModule(),
        ppr: true,
        store,
      });
      expect(visitor.response.headers.get("x-rango-shell")).toBe("HIT");
      await readAll(visitor.response.body!);
      expect(getShell).toHaveBeenCalledTimes(1);
    });

    // CFCacheStore is read through readShellDocument (rsc-rendering.ts
    // readShellEntry), so a getShell spy would not see its read.
    it("reads nothing from a CFCacheStore that holds the shell (no Cache API or KV read)", async () => {
      try {
        const cf = createCfShellFixture();
        await cf.store.putShell(KEY, shellEntry(), 300, 30);
        await cf.drain();
        const matches = cf.counts.matches;
        const kvGet = vi.spyOn(cf.kv, "get");
        const readShellDocument = vi.spyOn(cf.store, "readShellDocument");
        const ssrModule = fullSsrModule();
        const { arm } = warm("replace");

        const { response } = await run({
          ssrModule,
          ppr: true,
          store: cf.store,
          arm,
        });

        expect(response.headers.get("x-rango-shell")).toBe("MISS");
        expect(ssrModule.resumeShellHTML).not.toHaveBeenCalled();
        expect(readShellDocument).not.toHaveBeenCalled();
        expect(cf.counts.matches).toBe(matches);
        expect(kvGet).not.toHaveBeenCalled();
        expect(scheduledDescriptor().force).toBe(true);

        // Control: a visitor's request reads that shell from the Cache API.
        const visitor = await run({
          ssrModule: fullSsrModule(),
          ppr: true,
          store: cf.store,
        });
        expect(visitor.response.headers.get("x-rango-shell")).toBe("HIT");
        await readAll(visitor.response.body!);
        expect(readShellDocument).toHaveBeenCalledTimes(1);
        expect(cf.counts.matches).toBe(matches + 1);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("the record learns each capture event before the router's debugShellCapture sink receives it", async () => {
      const ssrModule = fullSsrModule();
      const { record, arm } = warm("replace");
      const seenByRouter: Array<{
        event: ShellCaptureDebugEvent;
        shell: PrerenderWarmRecord["shell"];
      }> = [];
      const router = {
        ...makeCtx(ssrModule, "stream").ctx.router,
        debugShellCapture: (event: ShellCaptureDebugEvent) => {
          seenByRouter.push({ event, shell: record.shell });
        },
      } as unknown as HandlerContext<unknown>["router"];

      await run({ ssrModule, ppr: true, router, arm });
      const sink = scheduledDescriptor().debugSink!;
      // A cold first attempt, then the in-place retry that stores.
      const cold: ShellCaptureDebugEvent = {
        key: KEY,
        outcome: "no-shell",
        attempt: 1,
      };
      const stored: ShellCaptureDebugEvent = {
        key: KEY,
        outcome: "stored",
        attempt: 2,
      };
      sink(cold);
      expect(record.shell).toBe("no-shell");
      // captureAndStoreShell counts the write before the event is published.
      record.writes.shell = 1;
      sink(stored);

      expect(record.shell).toBe("stored");
      expect(seenByRouter).toEqual([
        { event: cold, shell: "no-shell" },
        { event: stored, shell: "stored" },
      ]);
      // The capture's own event objects, not copies.
      expect(seenByRouter[0]!.event).toBe(cold);
      expect(seenByRouter[1]!.event).toBe(stored);
    });

    it("the record learns a refused capture's reason, with no router sink configured", async () => {
      const { record, arm } = warm("replace");

      await run({ ssrModule: fullSsrModule(), ppr: true, arm });
      scheduledDescriptor().debugSink!({
        key: KEY,
        outcome: "refused",
        attempt: 1,
        refusal: "identity",
      });

      expect(record.shell).toBe("refused");
      expect(record.refusal).toBe("identity");
    });

    it("control: a visitor's capture keeps the router's sink as it is", async () => {
      const ssrModule = fullSsrModule();
      const debugShellCapture = vi.fn();
      const router = {
        ...makeCtx(ssrModule, "stream").ctx.router,
        debugShellCapture,
      } as unknown as HandlerContext<unknown>["router"];

      await run({ ssrModule, ppr: true, router });

      const descriptor = scheduledDescriptor();
      expect(descriptor.debugSink).toBe(debugShellCapture);
      expect(descriptor.force).toBeUndefined();
    });
  });

  describe("a route with a build shell", () => {
    let loadManifest: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      resetBuildShellManifestForTests();
      resetShellServeStateForTests();
      vi.mocked(hasBuildShell).mockClear();
      loadManifest = vi.fn(async () => ({
        default: { [buildShellManifestKey("test-router", "/p")]: "/p" },
        loadShellAsset: async () => ({
          default: {
            entry: shellEntry({ docKey: undefined }),
            ttl: 300,
            routeName: "p",
          },
        }),
      }));
      (globalThis as any).__loadShellManifestModule = loadManifest;
    });
    afterEach(() => {
      delete (globalThis as any).__loadShellManifestModule;
      resetBuildShellManifestForTests();
    });

    it("replace mode: the build shell is not looked up; the request is a MISS with a forced capture", async () => {
      const ssrModule = fullSsrModule();
      const { arm } = warm("replace");

      const { response } = await run({ ssrModule, ppr: true, arm });

      expect(response.headers.get("x-rango-shell")).toBe("MISS");
      expect(ssrModule.resumeShellHTML).not.toHaveBeenCalled();
      // A build-shell lookup loads the manifest (shell-build-manifest.ts
      // lookupBuildShell); the fill-mode HIT below is the control.
      expect(loadManifest).not.toHaveBeenCalled();
      expect(scheduledDescriptor().force).toBe(true);
    });

    it("replace mode: a partitioned request does not probe for the build shell", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const store = partitionedStore();
        const { arm } = warm("replace");

        const { response } = await run({
          ssrModule: fullSsrModule(),
          ppr: true,
          store,
          arm,
        });

        expect(response.headers.get("x-rango-shell")).toBe("MISS");
        expect(hasBuildShell).not.toHaveBeenCalled();
        expect(loadManifest).not.toHaveBeenCalled();

        // Control: a fill-mode warm of the same partition probes like a
        // visitor's request.
        await run({
          ssrModule: fullSsrModule(),
          ppr: true,
          store,
          arm: warm("fill").arm,
        });
        expect(hasBuildShell).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    });

    it("fill mode: the build shell serves a HIT and the record reports fresh", async () => {
      const ssrModule = fullSsrModule();
      const { record, arm } = warm("fill");

      const { response } = await run({ ssrModule, ppr: true, arm });

      expect(response.headers.get("x-rango-shell")).toBe("HIT");
      await readAll(response.body!);
      expect(loadManifest).toHaveBeenCalledTimes(1);
      expect(record.shell).toBe("fresh");
      expect(scheduleMock).not.toHaveBeenCalled();
    });
  });

  // The record of a ppr route says why no shell was written: the stamp set
  // once resolvePprConfig returned a config stands for every gate that
  // passes after it.
  describe("a gate that passes on the shell reports not-eligible", () => {
    const gates: Array<[string, Partial<RunOpts>]> = [
      [
        "a provider nonce",
        { nonce: "abc123", url: "http://localhost/warm-nonce-provider" },
      ],
      [
        "a nonce set through the token",
        {
          url: "http://localhost/warm-nonce-token",
          arm: (reqCtx) =>
            contextSet(reqCtx._variables, nonceToken, "tok-nonce"),
        },
      ],
      [
        "a store without the shell family",
        { store: {}, url: "http://localhost/warm-no-shell-family" },
      ],
      [
        "the route's cache(false) opt-out",
        {
          arm: (reqCtx) => {
            (reqCtx._classifiedRoute as any).manifestEntry.cache = {
              options: false,
            };
          },
        },
      ],
      [
        "a partition key that failed to resolve",
        {
          store: Object.assign(new MemorySegmentCacheStore(), {
            keyGenerator: async (): Promise<string> => {
              throw new Error("key boom");
            },
          }),
        },
      ],
      ["a buffered (allReady) response", { streamMode: "allReady" }],
      [
        "a request flagged forced-MISS",
        {
          arm: (reqCtx) => {
            reqCtx._shellForcedMiss = true;
          },
        },
      ],
      [
        // Middleware called ctx.dynamic() before the shell plan ran.
        "a request already marked dynamic",
        {
          arm: (reqCtx) => {
            reqCtx._dynamic = true;
          },
        },
      ],
    ];

    it.each(gates)("%s", async (_label, gate) => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      // The failed partition key is reported (reportCacheError).
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        for (const mode of ["replace", "fill"] as const) {
          scheduleMock.mockClear();
          const { record, arm } = warm(mode, gate.arm);

          const { response } = await run({
            ssrModule: fullSsrModule(),
            ppr: true,
            ...gate,
            arm,
          });

          expect(response.headers.has("x-rango-shell"), mode).toBe(false);
          expect(scheduleMock, mode).not.toHaveBeenCalled();
          expect(record.shell, mode).toBe("not-eligible");
        }
      } finally {
        warnSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });
  });

  it.each([
    ["no ppr option", undefined],
    ["ppr: false", false],
  ] as const)(
    "a route with %s leaves record.shell undefined",
    async (_label, ppr) => {
      for (const mode of ["replace", "fill"] as const) {
        const store = new MemorySegmentCacheStore();
        await store.putShell(KEY, shellEntry(), 300, 30);
        const { record, arm } = warm(mode);

        const { response } = await run({
          ssrModule: fullSsrModule(),
          ppr,
          store,
          arm,
        });

        expect(response.headers.has("x-rango-shell"), mode).toBe(false);
        expect(record.shell, mode).toBeUndefined();
        expect(scheduleMock, mode).not.toHaveBeenCalled();
      }
    },
  );

  describe("fill mode (onlyIfStale)", () => {
    it("a servable stored shell is a HIT read from the store, and the record reports fresh", async () => {
      const store = new MemorySegmentCacheStore();
      await store.putShell(KEY, shellEntry(), 300, 30);
      const getShell = vi.spyOn(store, "getShell");
      const ssrModule = fullSsrModule();
      const { record, arm } = warm("fill");

      const { response } = await run({ ssrModule, ppr: true, store, arm });

      expect(response.headers.get("x-rango-shell")).toBe("HIT");
      expect(await readAll(response.body!)).toBe(`${PRELUDE_HTML}RESUMED-HOLE`);
      expect(getShell).toHaveBeenCalledTimes(1);
      expect(record.shell).toBe("fresh");
      expect(scheduleMock).not.toHaveBeenCalled();
    });

    it("a stale (SWR) hit reports fresh, then what its unforced recapture ends with", async () => {
      const store = new MemorySegmentCacheStore();
      // Stale at once, servable for 300 s, past the minimum recapture interval.
      await store.putShell(
        KEY,
        shellEntry({ createdAt: Date.now() - 2_000 }),
        0,
        300,
      );
      await new Promise((r) => setTimeout(r, 5));
      const { record, arm } = warm("fill");

      const { response } = await run({
        ssrModule: fullSsrModule(),
        ppr: true,
        store,
        arm,
      });

      expect(response.headers.get("x-rango-shell")).toBe("HIT");
      await readAll(response.body!);
      expect(record.shell).toBe("fresh");
      const descriptor = scheduledDescriptor();
      expect(descriptor.force).toBeUndefined();
      record.writes.shell = 1;
      descriptor.debugSink!({ key: KEY, outcome: "stored", attempt: 1 });
      expect(record.shell).toBe("stored");
    });

    it("a MISS reads the store and schedules its capture without force", async () => {
      const store = new MemorySegmentCacheStore();
      const getShell = vi.spyOn(store, "getShell");
      const ssrModule = fullSsrModule();
      const { record, arm } = warm("fill");

      const { response } = await run({ ssrModule, ppr: true, store, arm });

      expect(response.headers.get("x-rango-shell")).toBe("MISS");
      expect(getShell).toHaveBeenCalledTimes(1);
      const descriptor = scheduledDescriptor();
      expect(descriptor.force).toBeUndefined();
      // The sequence a visitor's MISS takes, so skip-stored still applies.
      expect(typeof descriptor.storedSeqAtRead).toBe("number");
      expect(record.shell).toBe("not-eligible");
      record.writes.shell = 1;
      descriptor.debugSink!({ key: KEY, outcome: "stored", attempt: 1 });
      expect(record.shell).toBe("stored");
    });
  });
});
