import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { createShellCacheMiddleware } from "../shell-cache.js";
import { MemorySegmentCacheStore } from "../memory-segment-store.js";
import type { ShellCacheEntry } from "../types.js";
import type {
  MiddlewareContext,
  MiddlewareFn,
} from "../../router/middleware.js";
import * as requestContext from "../../server/request-context.js";
import { captureAndStoreShell } from "../../rsc/shell-capture.js";
import { createHandleStore } from "../../server/handle-store.js";
import type { SSRModule } from "../../rsc/types.js";

/**
 * Invoke the middleware and narrow its `Promise<Response | void>` return to
 * `Response` (a MiddlewareFn may return void; this middleware always resolves a
 * Response). Mirrors document-cache.test.ts's `as Response` cast.
 */
function invoke(
  mw: MiddlewareFn<any>,
  ctx: MiddlewareContext<any>,
  next: () => Promise<Response>,
): Promise<Response> {
  return mw(ctx, next) as Promise<Response>;
}

// ============================================================================
// Helpers
// ============================================================================

const REACT_VERSION = React.version;

/** A minimal shell entry with the current React version (a valid hit). */
function shellEntry(overrides: Partial<ShellCacheEntry> = {}): ShellCacheEntry {
  return {
    prelude: btoa("<html><body>SHELL</body></html>"),
    postponed: JSON.stringify({ hole: 1 }),
    reactVersion: REACT_VERSION,
    createdAt: Date.now(),
    ...overrides,
  };
}

/**
 * Mock request context. Carries the two internal PPR flags plus the seams the
 * middleware reaches for: _cacheStore, _requestTags, and a waitUntil that pushes
 * background tasks onto `pending` so a test can drain them deterministically.
 */
function makeRequestCtx(store: unknown, pending: Promise<unknown>[]) {
  return {
    _cacheStore: store,
    _requestTags: new Set<string>(),
    _shellResume: undefined as { postponed: string | null } | undefined,
    _shellCapture: undefined as
      | {
          key: string;
          ttl?: number;
          swr?: number;
          tags?: string[];
          store?: unknown;
          debug?: boolean;
        }
      | undefined,
    _shellCaptureRun: undefined as boolean | undefined,
    waitUntil: (fn: () => Promise<void>) => {
      pending.push(fn());
    },
    _reportBackgroundError: vi.fn(),
  };
}

type MockRequestCtx = ReturnType<typeof makeRequestCtx>;

/**
 * Build a mock MiddlewareContext mirroring production: ctx.request.url is the raw
 * URL (all params), ctx.url is stripped of _rsc* params (as the pipeline does).
 */
function makeMiddlewareCtx(
  url: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): MiddlewareContext<any> {
  const rawUrl = new URL(url, "http://localhost");
  const request = new Request(rawUrl.toString(), {
    method: options.method ?? "GET",
    headers: options.headers ?? { accept: "text/html" },
  });
  const strippedUrl = new URL(rawUrl);
  for (const key of [...strippedUrl.searchParams.keys()]) {
    if (key.startsWith("_rsc")) strippedUrl.searchParams.delete(key);
  }
  return {
    request,
    url: strippedUrl,
    env: {},
  } as unknown as MiddlewareContext<any>;
}

/** A 200 HTML document response (a shell capture candidate on MISS). */
function html200(body: string, extraHeaders: Record<string, string> = {}) {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html", ...extraHeaders },
  });
}

const MARKER = "x-rango-shell-resumed";

// ============================================================================

describe("createShellCacheMiddleware", () => {
  let store: MemorySegmentCacheStore;
  let pending: Promise<unknown>[];
  let currentCtx: MockRequestCtx;
  let getCtxSpy: ReturnType<typeof vi.spyOn>;
  let consoleError: ReturnType<typeof vi.spyOn>;
  let consoleLog: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    store = new MemorySegmentCacheStore();
    pending = [];
    currentCtx = makeRequestCtx(store, pending);
    // getRequestContext() returns whatever currentCtx is at call time, so a test
    // can swap the ctx between two middleware invocations (stampede test).
    getCtxSpy = vi
      .spyOn(requestContext, "getRequestContext")
      .mockImplementation(() => currentCtx as any);
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    getCtxSpy.mockRestore();
    consoleError.mockRestore();
    consoleLog.mockRestore();
  });

  // --------------------------------------------------------------------------
  // Bypass matrix (middleware-enforced rows)
  // --------------------------------------------------------------------------

  describe("bypass matrix", () => {
    it("bypasses a non-GET request (never touches the store)", async () => {
      const getShell = vi.spyOn(store, "getShell");
      const mw = createShellCacheMiddleware();
      const ctx = makeMiddlewareCtx("http://localhost/p", { method: "POST" });
      const next = vi.fn(async () => html200("x"));
      const res = await invoke(mw, ctx, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.headers.has("x-rango-shell")).toBe(false);
      expect(getShell).not.toHaveBeenCalled();
    });

    it.each(["_rsc_action", "_rsc_loader", "_rsc_partial"])(
      "bypasses a %s request",
      async (param) => {
        const getShell = vi.spyOn(store, "getShell");
        const mw = createShellCacheMiddleware();
        const ctx = makeMiddlewareCtx(`http://localhost/p?${param}=1`);
        const next = vi.fn(async () => html200("x"));
        await mw(ctx, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(getShell).not.toHaveBeenCalled();
      },
    );

    it("bypasses an RSC request (Accept without text/html → !mayNeedSSR)", async () => {
      const getShell = vi.spyOn(store, "getShell");
      const mw = createShellCacheMiddleware();
      const ctx = makeMiddlewareCtx("http://localhost/p", {
        headers: { accept: "text/x-component" },
      });
      const next = vi.fn(async () => html200("x"));
      await mw(ctx, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(getShell).not.toHaveBeenCalled();
    });

    it("bypasses a skipPaths prefix", async () => {
      const getShell = vi.spyOn(store, "getShell");
      const mw = createShellCacheMiddleware({ skipPaths: ["/admin"] });
      const ctx = makeMiddlewareCtx("http://localhost/admin/x");
      const next = vi.fn(async () => html200("x"));
      await mw(ctx, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(getShell).not.toHaveBeenCalled();
    });

    it("bypasses when isEnabled returns false", async () => {
      const getShell = vi.spyOn(store, "getShell");
      const mw = createShellCacheMiddleware({ isEnabled: () => false });
      const ctx = makeMiddlewareCtx("http://localhost/p");
      const next = vi.fn(async () => html200("x"));
      await mw(ctx, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(getShell).not.toHaveBeenCalled();
    });

    it("bypasses when the store lacks the shell family", async () => {
      currentCtx = makeRequestCtx({}, pending); // store with no getShell/putShell
      const mw = createShellCacheMiddleware();
      const ctx = makeMiddlewareCtx("http://localhost/p");
      const next = vi.fn(async () => html200("x"));
      const res = await invoke(mw, ctx, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.headers.has("x-rango-shell")).toBe(false);
    });

    // Deliverable 4(b): the middleware must be INERT inside any capture render. The
    // background capture derives a context with _shellCaptureRun: true and re-runs
    // router.match(); if this middleware ever executes inside that render (DSL
    // middleware() attachment, or a future change to where route middleware runs),
    // it must NOT getShell, arm _shellResume, or set the _shellCapture descriptor
    // (which would recursively schedule a capture-within-a-capture). It falls
    // straight through to next(). See docs/design/ppr-shell-resume.md.
    it("bypasses when inside a capture render (_shellCaptureRun set): passthrough, no getShell, no flags armed", async () => {
      const getShell = vi.spyOn(store, "getShell");
      currentCtx._shellCaptureRun = true;
      const mw = createShellCacheMiddleware({ debug: true });
      const ctx = makeMiddlewareCtx("http://localhost/p");
      const next = vi.fn(async () => html200("x"));

      const res = await invoke(mw, ctx, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(getShell).not.toHaveBeenCalled();
      // No PPR flags were armed for the render layer.
      expect(currentCtx._shellResume).toBeUndefined();
      expect(currentCtx._shellCapture).toBeUndefined();
      // Plain passthrough — no shell status header.
      expect(res.headers.has("x-rango-shell")).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // MISS
  // --------------------------------------------------------------------------

  describe("MISS", () => {
    it("calls next() EXACTLY ONCE, sets the capture descriptor during it, and clears it after", async () => {
      const mw = createShellCacheMiddleware({
        ttlSeconds: 300,
        swrSeconds: 30,
      });
      const ctx = makeMiddlewareCtx("http://localhost/miss");

      let seenDescriptor: MockRequestCtx["_shellCapture"];
      const next = vi.fn(async () => {
        // The render layer reads the descriptor here (synchronously, inside the
        // single next()) to schedule the background capture.
        seenDescriptor = currentCtx._shellCapture
          ? { ...currentCtx._shellCapture }
          : undefined;
        return html200("<html>MISS</html>");
      });

      const res = await invoke(mw, ctx, next);
      expect(res.headers.get("x-rango-shell")).toBe("MISS");
      expect(await res.text()).toBe("<html>MISS</html>");

      // ONE next() — the executor's per-entry next() is a single-use latch, so a
      // second call would throw. Capture is a render-layer background task, not a
      // second pipeline pass.
      expect(next).toHaveBeenCalledTimes(1);

      // The descriptor was armed for the render layer: key/ttl/swr/store/debug, and
      // NO tags (the background capture collects the shell's own non-loader tags).
      // `debug` is threaded so the capture layer can gate its per-attempt retry
      // breadcrumbs on the same switch as this middleware's HIT/MISS lines.
      expect(seenDescriptor).toEqual({
        key: "localhost/miss:shell",
        ttl: 300,
        swr: 30,
        store,
        debug: false,
      });
      // Cleared after next() so it never leaks into a reused ctx.
      expect(currentCtx._shellCapture).toBeUndefined();
    });

    it("works under a single-use next() latch (regression for the double-next bug)", async () => {
      // Mirror middleware.ts wrappedNext: a second next() throws. The old design
      // called next() twice on MISS and blew up here in real workers.
      const mw = createShellCacheMiddleware();
      const ctx = makeMiddlewareCtx("http://localhost/latched");

      let called = 0;
      const latchedNext = vi.fn(async () => {
        if (called > 0) {
          throw new Error(
            "[@rangojs/router] Middleware called next() more than once.",
          );
        }
        called++;
        return html200("<html>latched</html>");
      });

      const res = await invoke(mw, ctx, latchedNext);
      expect(res.headers.get("x-rango-shell")).toBe("MISS");
      expect(latchedNext).toHaveBeenCalledTimes(1);
      expect(currentCtx._shellCapture).toBeUndefined();
    });

    it("still calls next() once (and tags MISS) for a non-HTML 200 response", async () => {
      // The 200-HTML eligibility gate lives in the render layer; the middleware
      // sets the descriptor and calls next() once regardless of the body type.
      const mw = createShellCacheMiddleware();
      const ctx = makeMiddlewareCtx("http://localhost/api");
      const next = vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );
      const res = await invoke(mw, ctx, next);
      expect(res.headers.get("x-rango-shell")).toBe("MISS");
      expect(next).toHaveBeenCalledTimes(1);
      expect(currentCtx._shellCapture).toBeUndefined();
    });

    it("still calls next() once (and tags MISS) for a redirect", async () => {
      const mw = createShellCacheMiddleware();
      const ctx = makeMiddlewareCtx("http://localhost/redir");
      const next = vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "/elsewhere" },
          }),
      );
      const res = await invoke(mw, ctx, next);
      expect(res.status).toBe(302);
      expect(res.headers.get("x-rango-shell")).toBe("MISS");
      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  // --------------------------------------------------------------------------
  // Store-attached middleware: options.store is BOTH the read and write store
  // --------------------------------------------------------------------------

  describe("store-attached middleware (options.store)", () => {
    it("capture writes to options.store (not _cacheStore) and the next pass reads it back as a HIT", async () => {
      const appStore = new MemorySegmentCacheStore(); // requestCtx._cacheStore
      const mwStore = new MemorySegmentCacheStore(); // middleware options.store
      currentCtx = makeRequestCtx(appStore, pending);

      const mw = createShellCacheMiddleware({ store: mwStore });

      // The background re-run performs a REAL captureAndStoreShell (stubbed
      // prerender) so the write path under test is the production one — the
      // flag's store threading, not a test simulation of it.
      const ssrModule = {
        renderHTML: vi.fn(),
        captureShellHTML: vi.fn(async () => ({
          prelude: new TextEncoder().encode(
            "<html><body>CAPTURED</body></html>",
          ),
          postponed: JSON.stringify({ hole: 1 }),
        })),
      } as unknown as SSRModule;

      const next = vi.fn(async () => {
        // Resume (HIT) path: the render layer marks the response.
        if (currentCtx._shellResume) {
          return html200("HOLE", { [MARKER]: "1" });
        }
        // MISS foreground: the render layer, seeing the descriptor, runs the
        // background capture. Simulate it synchronously here through the REAL
        // store-write path so the descriptor's store threading is under test.
        if (currentCtx._shellCapture) {
          await captureAndStoreShell(
            ssrModule,
            new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
            createHandleStore(),
            currentCtx as any,
            currentCtx._shellCapture as any,
          );
        }
        return html200("<html>live</html>");
      });

      // First pass: MISS on mwStore, background capture runs.
      const miss = await invoke(
        mw,
        makeMiddlewareCtx("http://localhost/attached"),
        next,
      );
      expect(miss.headers.get("x-rango-shell")).toBe("MISS");
      await Promise.all(pending);

      // The capture landed in the middleware's own store, NOT the app store.
      expect(await mwStore.getShell("localhost/attached:shell")).not.toBeNull();
      expect(await appStore.getShell("localhost/attached:shell")).toBeNull();

      // Second pass: the same middleware reads back what its capture wrote.
      const hit = await invoke(
        mw,
        makeMiddlewareCtx("http://localhost/attached"),
        next,
      );
      expect(hit.headers.get("x-rango-shell")).toBe("HIT");
      expect(await hit.text()).toBe("<html><body>CAPTURED</body></html>HOLE");
    });
  });

  // --------------------------------------------------------------------------
  // Host scoping (multi-tenant)
  // --------------------------------------------------------------------------

  describe("host-scoped keys", () => {
    it("never serves one host's shell to another host with the same path", async () => {
      // Tenant A's shell sits in the shared store under a host-qualified key.
      // In a host-router deployment one worker + one store serves many hosts;
      // a host-less key would compose tenant A's markup into tenant B's page.
      await store.putShell(
        "tenant-a.example/page:shell",
        shellEntry(),
        300,
        30,
      );

      const mw = createShellCacheMiddleware();
      // Same pathname, different tenant, same worker and store.
      const ctx = makeMiddlewareCtx("http://tenant-b.example/page");

      let resumeArmed: unknown;
      let captureKey: string | undefined;
      const next = vi.fn(async () => {
        resumeArmed = currentCtx._shellResume;
        if (currentCtx._shellCapture) captureKey = currentCtx._shellCapture.key;
        return html200("<html>LIVE-B</html>");
      });

      const res = await invoke(mw, ctx, next);

      // Tenant B must MISS: resume is never armed with tenant A's shell.
      expect(res.headers.get("x-rango-shell")).toBe("MISS");
      expect(resumeArmed).toBeUndefined();
      expect(await res.text()).toBe("<html>LIVE-B</html>");

      // The scheduled capture is keyed to tenant B's own host, and tenant A's
      // entry is untouched.
      await Promise.all(pending);
      expect(captureKey).toBe("tenant-b.example/page:shell");
      expect(
        await store.getShell("tenant-a.example/page:shell"),
      ).not.toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // HIT
  // --------------------------------------------------------------------------

  describe("HIT with the resume marker", () => {
    it("composes prelude bytes ahead of the live body, strips the marker, sets x-rango-shell: HIT, preserves live headers", async () => {
      await store.putShell("localhost/hit:shell", shellEntry(), 300, 30);

      const mw = createShellCacheMiddleware();
      const ctx = makeMiddlewareCtx("http://localhost/hit");

      let resumeArmed: { postponed: string | null } | undefined;
      const next = vi.fn(async () => {
        resumeArmed = currentCtx._shellResume; // render layer would read this
        return new Response("HOLE-CONTENT", {
          status: 200,
          headers: {
            "content-type": "text/html",
            [MARKER]: "1",
            "set-cookie": "sid=abc",
            "x-live": "yes",
          },
        });
      });

      const res = await invoke(mw, ctx, next);

      // Resume was armed with the stored postponed state before next() ran.
      expect(resumeArmed).toEqual({ postponed: JSON.stringify({ hole: 1 }) });

      // Composition: prelude bytes precede the live (resumed) body bytes.
      const text = await res.text();
      expect(text).toBe("<html><body>SHELL</body></html>HOLE-CONTENT");
      expect(text.indexOf("SHELL")).toBeLessThan(text.indexOf("HOLE-CONTENT"));

      // Marker stripped, status header set, live headers preserved.
      expect(res.headers.get(MARKER)).toBeNull();
      expect(res.headers.get("x-rango-shell")).toBe("HIT");
      expect(res.headers.get("set-cookie")).toBe("sid=abc");
      expect(res.headers.get("x-live")).toBe("yes");

      // The resume flag is disarmed after the pass.
      expect(currentCtx._shellResume).toBeUndefined();
    });

    it("a stale (SWR) hit resumes AND sets the descriptor so the render layer recaptures", async () => {
      // Fresh for 1s, then stale within the 300s SWR window.
      await store.putShell("localhost/swr:shell", shellEntry(), 1, 300);
      vi.setSystemTime(new Date("2024-01-01T00:00:02Z")); // +2s → stale

      const mw = createShellCacheMiddleware();
      const ctx = makeMiddlewareCtx("http://localhost/swr");

      // On a stale hit, resume (foreground) and capture-request (background)
      // coexist in ONE next(): _shellResume drives the marker, _shellCapture
      // tells the render layer to schedule a recapture.
      let resumeAndCaptureBoth = false;
      const next = vi.fn(async () => {
        resumeAndCaptureBoth =
          !!currentCtx._shellResume && !!currentCtx._shellCapture;
        return new Response("HOLE", {
          status: 200,
          headers: { "content-type": "text/html", [MARKER]: "1" },
        });
      });

      const res = await invoke(mw, ctx, next);
      expect(res.headers.get("x-rango-shell")).toBe("HIT");
      expect(await res.text()).toBe("<html><body>SHELL</body></html>HOLE");
      expect(next).toHaveBeenCalledTimes(1);
      expect(resumeAndCaptureBoth).toBe(true);
      // Both single-request flags disarmed after the pass.
      expect(currentCtx._shellResume).toBeUndefined();
      expect(currentCtx._shellCapture).toBeUndefined();
    });

    it("a FRESH hit resumes without setting the capture descriptor (no recapture)", async () => {
      await store.putShell("localhost/fresh:shell", shellEntry(), 300, 30);

      const mw = createShellCacheMiddleware();
      const ctx = makeMiddlewareCtx("http://localhost/fresh");

      let captureWanted = true;
      const next = vi.fn(async () => {
        captureWanted = !!currentCtx._shellCapture;
        return new Response("HOLE", {
          status: 200,
          headers: { "content-type": "text/html", [MARKER]: "1" },
        });
      });

      const res = await invoke(mw, ctx, next);
      expect(res.headers.get("x-rango-shell")).toBe("HIT");
      expect(captureWanted).toBe(false);
    });
  });

  describe("HIT without the resume marker", () => {
    it("returns the live response untouched (render layer bypassed resume)", async () => {
      await store.putShell("localhost/nomark:shell", shellEntry(), 300, 30);

      const mw = createShellCacheMiddleware();
      const ctx = makeMiddlewareCtx("http://localhost/nomark");
      // Render layer chose axis 1 (nonce/allReady/redirect): no marker set.
      const next = vi.fn(async () => html200("<html>full-render</html>"));

      const res = await invoke(mw, ctx, next);
      // Untouched: original body, NO prelude prepended, NO x-rango-shell header.
      expect(await res.text()).toBe("<html>full-render</html>");
      expect(res.headers.has("x-rango-shell")).toBe(false);
      expect(currentCtx._shellResume).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // reactVersion mismatch
  // --------------------------------------------------------------------------

  describe("reactVersion mismatch", () => {
    it("treats a version-mismatched entry as a MISS and recaptures", async () => {
      await store.putShell(
        "localhost/ver:shell",
        shellEntry({ reactVersion: "0.0.0-stale" }),
        300,
        30,
      );

      const mw = createShellCacheMiddleware();
      const ctx = makeMiddlewareCtx("http://localhost/ver");

      const resumeSeen: Array<unknown> = [];
      const next = vi.fn(async () => {
        resumeSeen.push(currentCtx._shellResume);
        return html200("<html>fresh</html>");
      });

      const res = await invoke(mw, ctx, next);
      // Never armed resume (mismatch is a miss, not a hit).
      expect(resumeSeen[0]).toBeUndefined();
      expect(res.headers.get("x-rango-shell")).toBe("MISS");
      // Single next(); the descriptor was armed for a render-layer recapture.
      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  // --------------------------------------------------------------------------
  // Resume failure policy
  // --------------------------------------------------------------------------

  describe("resume failure", () => {
    it("rethrows when next() throws while _shellResume is armed, and disarms the flag", async () => {
      await store.putShell("localhost/boom:shell", shellEntry(), 300, 30);

      const mw = createShellCacheMiddleware();
      const ctx = makeMiddlewareCtx("http://localhost/boom");
      const next = vi.fn(async () => {
        throw new Error("resume render failed");
      });

      await expect(mw(ctx, next)).rejects.toThrow("resume render failed");
      // The single-request flag must not leak past the failed pass.
      expect(currentCtx._shellResume).toBeUndefined();
    });
  });
});

// ============================================================================
// Memory store shell family — direct round-trip (put/get/ttl/swr/tags)
// ============================================================================

describe("MemorySegmentCacheStore shell family", () => {
  const T0 = new Date("2024-01-01T00:00:00Z").getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
  });
  afterEach(() => vi.useRealTimers());

  it("round-trips a shell entry", async () => {
    const store = new MemorySegmentCacheStore();
    const entry = shellEntry();
    await store.putShell("k", entry, 300, 30);
    const hit = await store.getShell("k");
    expect(hit).not.toBeNull();
    expect(hit?.entry).toEqual(entry);
    expect(hit?.shouldRevalidate).toBe(false);
  });

  it("returns null on a miss", async () => {
    const store = new MemorySegmentCacheStore();
    expect(await store.getShell("absent")).toBeNull();
  });

  it("is fresh before staleAt, stale (shouldRevalidate) within the SWR window, gone after expiry", async () => {
    const store = new MemorySegmentCacheStore();
    await store.putShell("k", shellEntry(), 60, 300); // stale +60s, expire +360s

    vi.setSystemTime(new Date(T0 + 30_000));
    expect((await store.getShell("k"))?.shouldRevalidate).toBe(false);

    vi.setSystemTime(new Date(T0 + 120_000));
    expect((await store.getShell("k"))?.shouldRevalidate).toBe(true);

    vi.setSystemTime(new Date(T0 + 400_000));
    expect(await store.getShell("k")).toBeNull();
  });

  it("is invalidated by tag", async () => {
    const store = new MemorySegmentCacheStore();
    await store.putShell("k", shellEntry(), 300, 30, ["home"]);
    expect(await store.getShell("k")).not.toBeNull();
    await store.invalidateTags(["home"]);
    expect(await store.getShell("k")).toBeNull();
  });

  it("keeps the shell family isolated from the response/item families on the same key", async () => {
    const store = new MemorySegmentCacheStore();
    await store.putShell("same", shellEntry(), 300, 30);
    await store.setItem("same", "item-value", { ttl: 300 });
    await store.putResponse("same", new Response("resp"), 300);
    expect((await store.getShell("same"))?.entry.prelude).toBe(
      shellEntry().prelude,
    );
    expect((await store.getItem("same"))?.value).toBe("item-value");
    expect(await (await store.getResponse("same"))?.response.text()).toBe(
      "resp",
    );
  });

  it("clear() drops shell entries too", async () => {
    const store = new MemorySegmentCacheStore();
    await store.putShell("k", shellEntry(), 300, 30);
    await store.clear();
    expect(await store.getShell("k")).toBeNull();
  });
});
