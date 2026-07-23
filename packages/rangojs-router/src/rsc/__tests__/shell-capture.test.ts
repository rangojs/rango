import { describe, it, expect, vi } from "vitest";
import React from "react";
import {
  gateFlightForCapture,
  captureAndStoreShell,
  runShellCapture,
  scheduleShellCapture,
  isCaptureBackedOff,
  markCaptureBackoff,
  clearCaptureBackoff,
  describeShellCaptureEvent,
  takeCaptureDebugEventForTiming,
  REFUSED_CAPTURE_DEV_MAX_MS,
  type ShellCaptureDebugEvent,
} from "../shell-capture.js";
import { SHELL_CAPTURE_TASK_HARD_CAP_MS } from "../shell-capture-constants.js";
import { RecordingShellStore } from "../../cache/shell-snapshot.js";
import type { ShellCacheEntry } from "../../cache/types.js";
import { createHandleStore } from "../../server/handle-store.js";
import {
  createRequestContext,
  getRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../server/request-context.js";
import { resolveTracing } from "../../router/tracing.js";
import { MemorySegmentCacheStore } from "../../cache/memory-segment-store.js";
import { CacheScope } from "../../cache/cache-scope.js";
import { cacheTag, recordRequestTags } from "../../cache/cache-tag.js";
import type { HandlerContext } from "../handler-context.js";
import type { SSRModule } from "../types.js";

// The drain lazily imports the Flight codec only for SETTLED bake-lane
// containers; the real module pulls the virtual @vitejs/plugin-rsc import that
// unit configs cannot resolve, so pin it to JSON here (shape-faithful for the
// hole-bit assertions below).
vi.mock("../../cache/segment-codec.js", () => ({
  serializeResult: vi.fn(async (value: unknown) => JSON.stringify(value)),
  deserializeResult: vi.fn(async (value: string) => JSON.parse(value)),
}));

/** True iff the promise settles within `ms`. */
function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([
    p.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
  ]);
}

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Drain a stream into the list of decoded chunks (drives the transform). */
async function drain(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const reader = stream.getReader();
  const out: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.length > 0) out.push(new TextDecoder().decode(value));
  }
  return out;
}

describe("gateFlightForCapture", () => {
  it("forwards chunks and quiesces after task-quantized byte silence — NOT on a 50ms wall clock", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });

    const { stream, quiesce, dispose } = gateFlightForCapture(source);

    // Consume in the background so the transform runs (pull-based) on each
    // enqueue — mirrors fizz reading the RSC stream.
    const chunks: string[] = [];
    const reader = stream.getReader();
    const readLoop = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.length > 0) chunks.push(new TextDecoder().decode(value));
      }
    })();

    const start = Date.now();
    controller.enqueue(enc("a"));
    controller.enqueue(enc("b"));

    // Quiesce resolves after a couple of macrotask hops of byte silence. The
    // hard contract: this is TASKS, not wall-clock — it must land far under
    // 50ms, so a reintroduced 50ms debounce would fail this test.
    expect(await settlesWithin(quiesce, 40)).toBe(true);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(40);

    // The shell rows were forwarded intact.
    expect(chunks).toEqual(["a", "b"]);

    dispose();
    controller.close();
    await readLoop;
  });

  it("freezes at quiesce: post-quiesce bytes are dropped and the readable is NOT closed", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });

    const { stream, quiesce, dispose } = gateFlightForCapture(source);
    const chunks: string[] = [];
    const reader = stream.getReader();
    let done = false;
    const readLoop = (async () => {
      for (;;) {
        const r = await reader.read();
        if (r.done) {
          done = true;
          break;
        }
        if (r.value.length > 0) chunks.push(new TextDecoder().decode(r.value));
      }
    })();

    controller.enqueue(enc("shell"));
    await quiesce; // gate freezes here

    // A post-quiesce byte (e.g. a late row or an error row from a later abort of
    // the underlying render) must never reach the fizz side.
    controller.enqueue(enc("LATE"));
    await new Promise((r) => setTimeout(r, 20));
    expect(chunks).toEqual(["shell"]);
    // And the readable stays OPEN (unclosing) so fizz postpones pending refs.
    expect(done).toBe(false);

    // dispose + cancel the reader to unwind the background loop for the test.
    dispose();
    await reader.cancel();
    await readLoop.catch(() => {});
  });

  it("holdUntil keeps the gate open (no freeze, no quiesce) until the baked handles resolve", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    let releaseHold!: () => void;
    const hold = new Promise<void>((r) => {
      releaseHold = r;
    });

    const { stream, quiesce, dispose } = gateFlightForCapture(
      source,
      undefined,
      hold,
    );
    const chunks: string[] = [];
    const reader = stream.getReader();
    const readLoop = (async () => {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        if (r.value.length > 0) chunks.push(new TextDecoder().decode(r.value));
      }
    })();

    controller.enqueue(enc("shell"));
    // Byte-quiet elapses many times over, but the hold is pending: no quiesce.
    expect(await settlesWithin(quiesce, 60)).toBe(false);

    // And crucially NO FREEZE: a late byte (the resolved top-level handles row)
    // still reaches the fizz side while held.
    controller.enqueue(enc("handles-row"));
    await new Promise((r) => setTimeout(r, 20));
    expect(chunks).toEqual(["shell", "handles-row"]);

    // Releasing the hold lets the quiet detection complete and fire.
    releaseHold();
    expect(await settlesWithin(quiesce, 100)).toBe(true);

    // Post-quiesce the gate is frozen as usual.
    controller.enqueue(enc("LATE"));
    await new Promise((r) => setTimeout(r, 20));
    expect(chunks).toEqual(["shell", "handles-row"]);

    dispose();
    await reader.cancel();
    await readLoop.catch(() => {});
  });

  it("quiets immediately when the source closes (DATA variant / no holes)", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc("shell"));
        c.close();
      },
    });
    const { stream, quiesce, dispose } = gateFlightForCapture(source);

    const chunks = await drain(stream);
    expect(chunks).toEqual(["shell"]);
    // flush() fired quiesce immediately on close, and the readable closed so
    // fizz would complete with postponed = null.
    expect(await settlesWithin(quiesce, 100)).toBe(true);
    dispose();
  });
});

// A closed Flight stream stand-in (the capture stub ignores it).
function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.close();
    },
  });
}

/** A putShell spy typed to the store family signature. */
function makePutShell() {
  return vi.fn(
    async (
      _key: string,
      _entry: ShellCacheEntry,
      _ttl?: number,
      _swr?: number,
      _tags?: string[],
    ) => {},
  );
}

// Local base64 decode mirroring the middleware's base64ToBytes, so the test
// verifies the stored prelude decodes with the SAME scheme the serve path uses.
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

describe("captureAndStoreShell", () => {
  function makeReqCtx(putShell?: ReturnType<typeof makePutShell>): any {
    return {
      _cacheStore: putShell ? { putShell } : undefined,
      _reportBackgroundError: vi.fn(),
      // The real derived context always seeds a fresh _requestTags (shell-capture
      // attemptCapture); the putShell write barrier snapshots it (issue #676), so
      // the direct-call stub must model the same required RequestContext field.
      _requestTags: new Set<string>(),
    };
  }

  function makeShellSsrModule(): SSRModule {
    return {
      renderHTML: vi.fn(),
      captureShellHTML: vi.fn(async () => ({
        prelude: enc("<html><body>shell</body></html>"),
        postponed: null,
      })),
    } as unknown as SSRModule;
  }

  // Capture settle budget (issue #715): descriptor.captureTimeout is THE
  // deadline handed to captureShellHTML — one bound covering the fizz
  // prerender AND the deferred-material settle window (the holdUntil gate).
  it("passes descriptor.captureTimeout to captureShellHTML as maxWaitMs", async () => {
    const ssrModule = makeShellSsrModule();
    await captureAndStoreShell(
      ssrModule,
      emptyStream(),
      createHandleStore(),
      makeReqCtx(makePutShell()),
      {
        key: "/budget:shell",
        buildVersion: "test-build",
        ttl: 300,
        captureTimeout: 10_000,
      },
    );
    const opts = vi.mocked(ssrModule.captureShellHTML!).mock.calls[0]![1];
    expect(opts.maxWaitMs).toBe(10_000);
  });

  it("defaults maxWaitMs to 15000 when no captureTimeout is declared", async () => {
    const ssrModule = makeShellSsrModule();
    await captureAndStoreShell(
      ssrModule,
      emptyStream(),
      createHandleStore(),
      makeReqCtx(makePutShell()),
      { key: "/budget-default:shell", buildVersion: "test-build", ttl: 300 },
    );
    const opts = vi.mocked(ssrModule.captureShellHTML!).mock.calls[0]![1];
    expect(opts.maxWaitMs).toBe(15_000);
  });

  it("marks request-dependent transition gates on the stored shell", async () => {
    const putShell = makePutShell();
    const reqCtx = makeReqCtx(putShell);
    reqCtx._transitionWhen = [{ id: "R0", when: () => true }];

    await captureAndStoreShell(
      makeShellSsrModule(),
      emptyStream(),
      createHandleStore(),
      reqCtx,
      { key: "/transition-when:shell", buildVersion: "test-build", ttl: 300 },
    );

    expect(putShell).toHaveBeenCalledOnce();
    expect(putShell.mock.calls[0]![1].transitionWhen).toBe(true);
  });

  it("stamps the marker's docKey onto the stored entry alongside its snapshot record", async () => {
    const putShell = makePutShell();
    const recording = new RecordingShellStore({ putShell } as any);
    const reqCtx = makeReqCtx();
    reqCtx._cacheStore = recording;
    // What the doc scope's cacheRoute does during the capture's match: record
    // the canonical doc segment record and publish its key on the marker.
    recording.recordSegmentWrite("doc:host/p", {
      segments: [{ encoded: "", metadata: { id: "R0" } } as any],
      handles: "",
      expiresAt: Date.now() + 60_000,
    });
    reqCtx._shellImplicitCache = { docKey: "doc:host/p" };

    await captureAndStoreShell(
      makeShellSsrModule(),
      emptyStream(),
      createHandleStore(),
      reqCtx,
      { key: "/doc-key:shell", buildVersion: "test-build", ttl: 300 },
    );

    expect(putShell).toHaveBeenCalledOnce();
    const entry = putShell.mock.calls[0]![1];
    expect(entry.docKey).toBe("doc:host/p");
    expect(entry.snapshot).toEqual([
      expect.objectContaining({ family: "segment", key: "doc:host/p" }),
    ]);
  });

  it("stores no docKey when the capture recorded no snapshot", async () => {
    const putShell = makePutShell();
    const reqCtx = makeReqCtx(putShell);
    // A stale marker docKey without a snapshot must not mint a replayable
    // claim — eligibility requires the record itself.
    reqCtx._shellImplicitCache = { docKey: "doc:host/p" };

    await captureAndStoreShell(
      makeShellSsrModule(),
      emptyStream(),
      createHandleStore(),
      reqCtx,
      { key: "/doc-key-empty:shell", buildVersion: "test-build", ttl: 300 },
    );

    expect(putShell).toHaveBeenCalledOnce();
    expect(putShell.mock.calls[0]![1].docKey).toBeUndefined();
  });

  it("refuses and reports a shell invalidated by its own capture render", async () => {
    const store = new MemorySegmentCacheStore();
    const reqCtx = makeReqCtx();
    reqCtx._cacheStore = store;
    const stats: Pick<ShellCaptureDebugEvent, "storeWrite"> = {};
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const captureStartedAt = Date.now();
    const ssrModule = {
      ...makeShellSsrModule(),
      captureShellHTML: vi.fn(async () => {
        await store.invalidateTags(["own-shell"]);
        return {
          prelude: enc("<html><body>shell</body></html>"),
          postponed: null,
        };
      }),
    } as unknown as SSRModule;

    const outcome = await captureAndStoreShell(
      ssrModule,
      emptyStream(),
      createHandleStore(),
      reqCtx,
      {
        key: "/self-invalidating:shell",
        buildVersion: "test-build",
        ttl: 300,
        tags: ["own-shell"],
      },
      stats,
      captureStartedAt,
    );

    expect(outcome).toBe("refused");
    expect(stats.storeWrite).toBe("invalidated");
    expect(await store.getShell("/self-invalidating:shell")).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("store rejected the write"),
    );
    warnSpy.mockRestore();
  });

  // Identity guard (loader-container-bake): the cookies()/headers() capture
  // guard flags the capture context before throwing, because a throw inside an
  // executing bake-lane loader is swallowed into per-loader error UI. The
  // capture must REFUSE (deterministic — no retry, no store write) instead of
  // baking the failure into a shared shell.
  it("refuses (no store write, once-per-key warning) when the identity guard tripped", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const putShell = makePutShell();
      const reqCtx = makeReqCtx(putShell);
      reqCtx._shellCaptureGuardTripped = "cookies";

      const outcome = await captureAndStoreShell(
        makeShellSsrModule(),
        emptyStream(),
        createHandleStore(),
        reqCtx,
        { key: "/guard-trip:shell", buildVersion: "test-build", ttl: 300 },
      );

      expect(outcome).toBe("refused");
      expect(putShell).not.toHaveBeenCalled();
      const warnings = warnSpy.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].includes("/guard-trip:shell"),
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0][0]).toContain("cookies()");
      expect(warnings[0][0]).toContain("refused");
    } finally {
      warnSpy.mockRestore();
    }
  });

  // A REJECTED bake-lane loader container must refuse the capture: its
  // per-loader error boundary UI already rendered into the shell bytes, and a
  // shared shell must never freeze error UI.
  it("refuses when a bake-lane loader container rejected during capture", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const putShell = makePutShell();
      const reqCtx = makeReqCtx(putShell);
      const rejected = Promise.reject(new Error("loader boom"));
      rejected.catch(() => {});
      reqCtx._shellCaptureLoaderRecords = new Map([["M0D0.app/x#L", rejected]]);

      const outcome = await captureAndStoreShell(
        makeShellSsrModule(),
        emptyStream(),
        createHandleStore(),
        reqCtx,
        { key: "/bake-reject:shell", buildVersion: "test-build", ttl: 300 },
      );

      expect(outcome).toBe("refused");
      expect(putShell).not.toHaveBeenCalled();
      const warnings = warnSpy.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].includes("/bake-reject:shell"),
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0][0]).toContain("M0D0.app/x#L");
    } finally {
      warnSpy.mockRestore();
    }
  });

  // The hole bit rides each pinned loader record (ShellSnapshotLoaderValue):
  // holes: 0 = fully pinned, the HIT overlay resolves pin-first without
  // gating on the fresh run; holes: 1 = hole markers present, the overlay
  // must wait for the fresh run's live promises. Computed once at capture
  // (elide already walks every node) so the per-HIT path never rescans.
  it("pins settled bake-lane containers with the capture-computed hole bit", async () => {
    const putShell = makePutShell();
    const reqCtx = makeReqCtx(putShell);
    const pending = new Promise(() => {});
    reqCtx._shellCaptureLoaderRecords = new Map<string, Promise<unknown>>([
      ["R0D0.app/x#Full", Promise.resolve({ price: 42 })],
      ["R0D1.app/x#Holey", Promise.resolve({ price: 42, live: pending })],
    ]);

    const outcome = await captureAndStoreShell(
      makeShellSsrModule(),
      emptyStream(),
      createHandleStore(),
      reqCtx,
      { key: "/bake-holes:shell", buildVersion: "test-build", ttl: 300 },
    );

    expect(outcome).toBe("stored");
    const entry = putShell.mock.calls[0]![1] as {
      snapshot?: { family: string; key: string; value: { holes?: 0 | 1 } }[];
    };
    const byKey = new Map(
      (entry.snapshot ?? [])
        .filter((r) => r.family === "loader")
        .map((r) => [r.key, r.value]),
    );
    expect(byKey.get("R0D0.app/x#Full")?.holes).toBe(0);
    expect(byKey.get("R0D1.app/x#Holey")?.holes).toBe(1);
  });

  // A container still PENDING at drain is a hole (or already hit the
  // trivial-prelude gate): it is omitted from the snapshot, never a refusal.
  it("omits a still-pending bake-lane container without refusing", async () => {
    const putShell = makePutShell();
    const reqCtx = makeReqCtx(putShell);
    reqCtx._shellCaptureLoaderRecords = new Map([
      ["M0D0.app/x#L", new Promise(() => {})],
    ]);

    const outcome = await captureAndStoreShell(
      makeShellSsrModule(),
      emptyStream(),
      createHandleStore(),
      reqCtx,
      { key: "/bake-pending:shell", buildVersion: "test-build", ttl: 300 },
    );

    expect(outcome).toBe("stored");
    expect(putShell).toHaveBeenCalledTimes(1);
    const entry = putShell.mock.calls[0]![1] as {
      snapshot?: { family: string }[];
    };
    const loaderRecords = (entry.snapshot ?? []).filter(
      (r) => r.family === "loader",
    );
    expect(loaderRecords).toHaveLength(0);
  });

  // Snapshot size cap (issue #651): the snapshot duplicates pinned ring data
  // inside the shell entry, so an over-cap snapshot is SKIPPED — the shell
  // still stores and serves (pinned reads drift, the pre-snapshot behavior) —
  // and the skip is reported once per key.
  it("skips an over-cap snapshot, still stores the shell, and reports once per key", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const putShell = makePutShell();
      const runOnce = async () => {
        // Fresh recording store per capture (mirrors the per-capture derived
        // context); one recorded item-family value well over the 1 KiB cap.
        const recording = new RecordingShellStore(
          new MemorySegmentCacheStore(),
        );
        await recording.setItem("big-key", "x".repeat(4096));
        const reqCtx = makeReqCtx();
        reqCtx._cacheStore = recording;
        return captureAndStoreShell(
          makeShellSsrModule(),
          emptyStream(),
          createHandleStore(),
          reqCtx,
          {
            key: "/over-cap:shell",
            buildVersion: "test-build",
            ttl: 300,
            maxSnapshotBytes: 1024,
            store: { putShell } as any,
          },
        );
      };

      // First capture: over cap → snapshot skipped, shell still stored.
      expect(await runOnce()).toBe("stored");
      // Recapture (TTL roll): still stores, still skips, does NOT re-warn.
      expect(await runOnce()).toBe("stored");

      expect(putShell).toHaveBeenCalledTimes(2);
      for (const call of putShell.mock.calls) {
        expect((call[1] as { snapshot?: unknown[] }).snapshot).toBeUndefined();
      }
      const warnings = warnSpy.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].includes("/over-cap:shell"),
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0][0]).toContain("1024-byte cap");
      expect(warnings[0][0]).toContain("maxSnapshotBytes");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("keeps an under-cap snapshot intact (default cap)", async () => {
    const putShell = makePutShell();
    const recording = new RecordingShellStore(new MemorySegmentCacheStore());
    await recording.setItem("small-key", "hello");
    const reqCtx = makeReqCtx();
    reqCtx._cacheStore = recording;

    const outcome = await captureAndStoreShell(
      makeShellSsrModule(),
      emptyStream(),
      createHandleStore(),
      reqCtx,
      {
        key: "/under-cap:shell",
        buildVersion: "test-build",
        ttl: 300,
        store: { putShell } as any,
      },
    );

    expect(outcome).toBe("stored");
    const entry = putShell.mock.calls[0]![1] as {
      snapshot?: { family: string; key: string }[];
    };
    expect(
      (entry.snapshot ?? []).some(
        (r) => r.family === "item" && r.key === "small-key",
      ),
    ).toBe(true);
  });

  it("stores the base64 prelude + postponed + reactVersion into the flag's store", async () => {
    const putShell = makePutShell();
    const preludeBytes = enc("<html><body>shell</body></html>");
    const ssrModule = {
      renderHTML: vi.fn(),
      captureShellHTML: vi.fn(async () => ({
        prelude: preludeBytes,
        postponed: '{"h":1}',
      })),
    } as unknown as SSRModule;

    await captureAndStoreShell(
      ssrModule,
      emptyStream(),
      createHandleStore(),
      // reqCtx._cacheStore is a DIFFERENT store; the flag's store must win.
      makeReqCtx(makePutShell()),
      {
        key: "/p:shell",
        buildVersion: "test-build",
        ttl: 300,
        swr: 60,
        tags: ["t1"],
        store: { putShell } as any,
      },
    );

    expect(putShell).toHaveBeenCalledTimes(1);
    const [key, entry, ttl, swr, tags] = putShell.mock.calls[0]!;
    expect(key).toBe("/p:shell");
    expect(ttl).toBe(300);
    expect(swr).toBe(60);
    expect(tags).toEqual(["t1"]);
    expect(entry.postponed).toBe('{"h":1}');
    expect(entry.reactVersion).toBe(React.version);
    // The descriptor's buildVersion stamps the entry — the serve-side validity
    // gate compares it against the running build.
    expect(entry.buildVersion).toBe("test-build");
    expect(typeof entry.createdAt).toBe("number");
    expect(
      new TextDecoder().decode(new Uint8Array(base64ToBytes(entry.prelude!))),
    ).toBe("<html><body>shell</body></html>");
  });

  it("attributes the slowest bake source: bakeWaitMs stat + once-per-key dev warning naming it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let now = 0;
    const perfSpy = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      let resolveLoader!: (value: unknown) => void;
      const loaderPromise = new Promise((resolve) => {
        resolveLoader = resolve;
      });
      const reqCtx = makeReqCtx();
      reqCtx._shellCaptureLoaderRecords = new Map([
        ["products.list", loaderPromise],
      ]);
      const captureShellHTML = vi.fn(async () => {
        // One macrotask first so the (instant) handles bake records at 0, then
        // jump the mocked clock and settle the loader — its observer records
        // the 3456ms hold. The extra microtask lets that observer run before
        // the capture result is consumed.
        await new Promise((resolve) => setTimeout(resolve, 0));
        now = 3456;
        resolveLoader({ ok: true });
        await loaderPromise;
        await Promise.resolve();
        return {
          prelude: enc("<html><body>shell</body></html>"),
          postponed: null,
        };
      });
      const ssrModule = {
        renderHTML: vi.fn(),
        captureShellHTML,
      } as unknown as SSRModule;

      const stats: { bakeWaitMs?: number } = {};
      const outcome = await captureAndStoreShell(
        ssrModule,
        emptyStream(),
        createHandleStore(),
        reqCtx,
        {
          key: "/bake-cost:shell",
          buildVersion: "test-build",
          ttl: 300,
          store: { putShell: makePutShell() } as any,
        },
        stats,
      );

      expect(outcome).toBe("stored");
      expect(stats.bakeWaitMs).toBe(3456);
      const bakeWarnings = warn.mock.calls.filter((call) =>
        String(call[0]).includes("waited 3456ms"),
      );
      expect(bakeWarnings).toHaveLength(1);
      expect(String(bakeWarnings[0]![0])).toContain(
        'bake-lane segment loader "products.list"',
      );
      // Remedy ladder is present: nest / cache() / loading().
      expect(String(bakeWarnings[0]![0])).toContain(
        "nest it ({ data: promise })",
      );
      expect(String(bakeWarnings[0]![0])).toContain("cache()");
      expect(String(bakeWarnings[0]![0])).toContain("loading()");

      // Once per key: a second expensive capture of the SAME key stays silent.
      now = 0;
      const again = await captureAndStoreShell(
        ssrModule,
        emptyStream(),
        createHandleStore(),
        makeReqCtx(),
        {
          key: "/bake-cost:shell",
          buildVersion: "test-build",
          ttl: 300,
          store: { putShell: makePutShell() } as any,
        },
      );
      expect(again).toBe("stored");
      expect(
        warn.mock.calls.filter((call) =>
          String(call[0]).includes("/bake-cost:shell"),
        ),
      ).toHaveLength(1);
    } finally {
      perfSpy.mockRestore();
      warn.mockRestore();
    }
  });

  it("navigationOnly capture drops the document half: no prelude/postponed stored", async () => {
    const putShell = makePutShell();
    const captureShellHTML = vi.fn(async () => ({
      prelude: enc("<html><body>nav shell</body></html>"),
      postponed: '{"h":1}',
    }));
    const ssrModule = {
      renderHTML: vi.fn(),
      captureShellHTML,
    } as unknown as SSRModule;

    const outcome = await captureAndStoreShell(
      ssrModule,
      emptyStream(),
      createHandleStore(),
      makeReqCtx(),
      {
        key: "/p:shell:navigation",
        buildVersion: "test-build",
        ttl: 300,
        store: { putShell } as any,
        navigationOnly: true,
      },
    );

    expect(outcome).toBe("stored");
    // The prerender still ran — it is the completeness arbiter and sanity gate.
    expect(captureShellHTML).toHaveBeenCalledTimes(1);
    const entry = putShell.mock.calls[0]![1];
    // Dropped, not stored empty: nothing serves a navigationOnly entry's HTML
    // (document reads skip the flag; replay consumes only snapshot/docKey).
    expect("prelude" in entry).toBe(false);
    expect("postponed" in entry).toBe(false);
    expect(entry.navigationOnly).toBe(true);
    expect(entry.reactVersion).toBe(React.version);
  });

  it("stores the capture context's theme as entry.initialTheme (resume theme fidelity)", async () => {
    const putShell = makePutShell();
    const ssrModule = {
      renderHTML: vi.fn(),
      captureShellHTML: vi.fn(async () => ({
        prelude: enc("<html><body>shell</body></html>"),
        postponed: null,
      })),
    } as unknown as SSRModule;
    const reqCtx = makeReqCtx();
    // The derived capture context's theme — buildFullPayload rendered with it,
    // so the serve tail must replay it (ShellCacheEntry.initialTheme).
    (reqCtx as any).theme = "light";

    await captureAndStoreShell(
      ssrModule,
      emptyStream(),
      createHandleStore(),
      reqCtx,
      {
        key: "/p:shell",
        buildVersion: "test-build",
        store: { putShell } as any,
      },
    );

    expect(putShell).toHaveBeenCalledTimes(1);
    expect(putShell.mock.calls[0]![1].initialTheme).toBe("light");
  });

  it("prefers the flag's store over reqCtx._cacheStore", async () => {
    const flagPut = makePutShell();
    const ctxPut = makePutShell();
    const ssrModule = {
      renderHTML: vi.fn(),
      captureShellHTML: vi.fn(async () => ({
        prelude: enc("<body>x</body>"),
        postponed: null,
      })),
    } as unknown as SSRModule;

    await captureAndStoreShell(
      ssrModule,
      emptyStream(),
      createHandleStore(),
      makeReqCtx(ctxPut),
      {
        key: "/p:shell",
        buildVersion: "test-build",
        store: { putShell: flagPut } as any,
      },
    );

    expect(flagPut).toHaveBeenCalledTimes(1);
    expect(ctxPut).not.toHaveBeenCalled();
  });

  it("returns 'no-shell' and stores nothing when the sanity gate refuses (null result)", async () => {
    const putShell = makePutShell();
    const ssrModule = {
      renderHTML: vi.fn(),
      captureShellHTML: vi.fn(async () => null),
    } as unknown as SSRModule;

    // captureAndStoreShell no longer warns (the caller owns retry/warn). It reports
    // the retryable outcome so runShellCapture can retry once, then warn.
    const outcome = await captureAndStoreShell(
      ssrModule,
      emptyStream(),
      createHandleStore(),
      makeReqCtx(putShell),
      {
        key: "/p:shell",
        buildVersion: "test-build",
        store: { putShell } as any,
      },
    );
    expect(outcome).toBe("no-shell");
    expect(putShell).not.toHaveBeenCalled();
  });

  it("rethrows a genuine AbortError from captureShellHTML", async () => {
    // createShellCaptureHandler converts only its private capture-abort sentinel
    // to null. Any error that escapes it, including one named AbortError, is a
    // genuine render failure and must reach the scheduler's error reporter.
    const putShell = makePutShell();
    const abortErr = Object.assign(new Error("component fetch canceled"), {
      name: "AbortError",
    });
    const ssrModule = {
      renderHTML: vi.fn(),
      captureShellHTML: vi.fn(async () => {
        throw abortErr;
      }),
    } as unknown as SSRModule;
    await expect(
      captureAndStoreShell(
        ssrModule,
        emptyStream(),
        createHandleStore(),
        makeReqCtx(putShell),
        {
          key: "/p:shell",
          buildVersion: "test-build",
          store: { putShell } as any,
        },
      ),
    ).rejects.toBe(abortErr);
    expect(putShell).not.toHaveBeenCalled();
  });

  it("rethrows a genuine (non-abort) captureShellHTML error so the caller reports it", async () => {
    const putShell = makePutShell();
    const ssrModule = {
      renderHTML: vi.fn(),
      captureShellHTML: vi.fn(async () => {
        throw new Error("shell component blew up");
      }),
    } as unknown as SSRModule;

    await expect(
      captureAndStoreShell(
        ssrModule,
        emptyStream(),
        createHandleStore(),
        makeReqCtx(putShell),
        {
          key: "/p:shell",
          buildVersion: "test-build",
          store: { putShell } as any,
        },
      ),
    ).rejects.toThrow("shell component blew up");
    expect(putShell).not.toHaveBeenCalled();
  });

  it("does not throw and routes putShell failures through reportCacheError", async () => {
    const putShell = vi.fn(async () => {
      throw new Error("KV down");
    });
    const ssrModule = {
      renderHTML: vi.fn(),
      captureShellHTML: vi.fn(async () => ({
        prelude: enc("<body>x</body>"),
        postponed: null,
      })),
    } as unknown as SSRModule;

    const reqCtx = makeReqCtx();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await captureAndStoreShell(
        ssrModule,
        emptyStream(),
        createHandleStore(),
        reqCtx,
        {
          key: "/p:shell",
          buildVersion: "test-build",
          store: { putShell } as any,
        },
      );
      expect(reqCtx._reportBackgroundError).toHaveBeenCalledTimes(1);
    } finally {
      errSpy.mockRestore();
    }
  });
});

// runShellCapture is the background capture core: it derives a fresh context,
// re-matches via router.match, builds the payload, and stores the shell. These
// tests stub the router/SSR seams and drive it directly (scheduleShellCapture's
// runBackground dispatch is exercised by the middleware round-trip tests).
describe("runShellCapture", () => {
  function makeCtx(
    match: any,
    captureShellHTML: SSRModule["captureShellHTML"],
  ): { ctx: HandlerContext<any>; ssrModule: SSRModule } {
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
        match: vi.fn(async () => match),
      },
      callOnError: vi.fn(),
      renderToReadableStream: vi.fn(() => emptyStream()),
    } as unknown as HandlerContext<any>;
    const ssrModule = {
      renderHTML: vi.fn(),
      resumeShellHTML: vi.fn(),
      captureShellHTML,
    } as unknown as SSRModule;
    return { ctx, ssrModule };
  }

  function makeReqCtx(
    putShell?: ReturnType<typeof makePutShell>,
  ): RequestContext {
    const reqCtx = createRequestContext({
      env: {},
      request: new Request("http://localhost/p"),
      url: new URL("http://localhost/p"),
      variables: {},
    }) as RequestContext;
    (reqCtx as any)._reportBackgroundError = vi.fn();
    if (putShell) (reqCtx as any)._cacheStore = { putShell };
    return reqCtx;
  }

  const okMatch = {
    redirect: undefined,
    segments: [],
    matched: [],
    diff: [],
    resolvedIds: [],
    params: {},
    routeName: "home",
  };

  it("re-matches, builds the shell, and stores it via the descriptor store (happy path)", async () => {
    const putShell = makePutShell();
    const { ctx, ssrModule } = makeCtx(
      okMatch,
      vi.fn(async () => ({
        prelude: enc("<html><body>captured</body></html>"),
        postponed: null,
      })),
    );
    const reqCtx = makeReqCtx();
    const request = new Request("http://localhost/p");

    await runShellCapture(
      ctx,
      request,
      {},
      new URL("http://localhost/p"),
      reqCtx,
      ssrModule,
      {
        key: "/p:shell",
        buildVersion: "test-build",
        ttl: 300,
        store: { putShell } as any,
      },
    );

    expect(ctx.router.match).toHaveBeenCalledTimes(1);
    expect(ssrModule.captureShellHTML).toHaveBeenCalledTimes(1);
    expect(putShell).toHaveBeenCalledTimes(1);
    expect(putShell.mock.calls[0]![0]).toBe("/p:shell");
    // The foreground store was untouched (the derived context isolates it).
    expect(reqCtx._handleStore).toBeDefined();
  });

  it("normalizes a navigation-only capture to document request identity", async () => {
    const putShell = makePutShell();
    const { ctx, ssrModule } = makeCtx(
      okMatch,
      vi.fn(async () => ({
        prelude: enc("<html><body>captured</body></html>"),
        postponed: null,
      })),
    );
    let matchedRequestUrl = "";
    let ambientIdentity:
      | Pick<RequestContext, "request" | "url" | "originalUrl" | "pathname">
      | undefined;
    const routeStoreGet = vi.fn(async () => null);
    (ctx.router.match as ReturnType<typeof vi.fn>).mockImplementation(
      async (request: Request) => {
        matchedRequestUrl = request.url;
        const active = getRequestContext();
        ambientIdentity = {
          request: active.request,
          url: active.url,
          originalUrl: active.originalUrl,
          pathname: active.pathname,
        };
        await new CacheScope({
          ttl: 60,
          store: { get: routeStoreGet } as any,
        }).lookupRoute("/p", {});
        return okMatch;
      },
    );
    const rawUrl = new URL(
      "http://localhost/p?probe=keep&_rsc_partial=true&_rsc_segments=L0",
    );
    const request = new Request(rawUrl, {
      headers: {
        accept: "text/x-component",
        authorization: "Bearer keep",
        "X-Rango-Prefetch": "1",
        "X-Rango-State": "transport-state",
        "X-RSC-HMR": "1",
        "X-RSC-Router-Client-Path": "/",
        "X-RSC-Router-Intercept-Source": "/source",
      },
    });
    const reqCtx = createRequestContext({
      env: {},
      request,
      url: rawUrl,
      variables: {},
    }) as RequestContext;

    await runShellCapture(ctx, request, {}, rawUrl, reqCtx, ssrModule, {
      key: "/p:shell:navigation",
      buildVersion: "test-build",
      ttl: 300,
      store: { putShell } as any,
      navigationOnly: true,
    });

    expect(matchedRequestUrl).toBe("http://localhost/p?probe=keep");
    expect(ambientIdentity?.url.toString()).toBe(
      "http://localhost/p?probe=keep",
    );
    expect(ambientIdentity?.originalUrl.toString()).toBe(
      "http://localhost/p?probe=keep",
    );
    expect(ambientIdentity?.pathname).toBe("/p");
    expect(ambientIdentity?.request.headers.get("accept")).toBe("text/html");
    expect(ambientIdentity?.request.headers.get("authorization")).toBe(
      "Bearer keep",
    );
    for (const name of [
      "x-rango-prefetch",
      "x-rango-state",
      "x-rsc-hmr",
      "x-rsc-router-client-path",
      "x-rsc-router-intercept-source",
    ]) {
      expect(ambientIdentity?.request.headers.has(name)).toBe(false);
    }
    expect(routeStoreGet).toHaveBeenCalledWith("doc:localhost/p?probe=keep");
  });

  // Capture-pipeline debug sink (issue #651): one structured event per
  // attempt, with the observability fields the console breadcrumbs never
  // carried (attempt duration, barrier wait, prelude bytes).
  it("emits one debug event per attempt (stored: outcome, sizes, waits)", async () => {
    const events: ShellCaptureDebugEvent[] = [];
    const putShell = makePutShell();
    const preludeHtml = "<html><body>captured</body></html>";
    const { ctx, ssrModule } = makeCtx(
      okMatch,
      vi.fn(async () => ({ prelude: enc(preludeHtml), postponed: null })),
    );

    await runShellCapture(
      ctx,
      new Request("http://localhost/p"),
      {},
      new URL("http://localhost/p"),
      makeReqCtx(),
      ssrModule,
      {
        key: "/debug-stored:shell",
        buildVersion: "test-build",
        ttl: 300,
        store: { putShell } as any,
        debugSink: (e) => events.push(e),
      },
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      key: "/debug-stored:shell",
      outcome: "stored",
      attempt: 1,
      preludeBytes: enc(preludeHtml).length,
    });
    expect(typeof events[0].attemptMs).toBe("number");
    expect(typeof events[0].barrierWaitMs).toBe("number");

    // Dev Server-Timing mirror: the terminal event is buffered per key and
    // CONSUMED on read (one capture = one later Server-Timing entry).
    const taken = takeCaptureDebugEventForTiming("/debug-stored:shell");
    expect(taken?.outcome).toBe("stored");
    expect(takeCaptureDebugEventForTiming("/debug-stored:shell")).toBe(
      undefined,
    );
  });

  it("reports TTL-only loader baking only through opt-in capture diagnostics", async () => {
    const events: ShellCaptureDebugEvent[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { ctx, ssrModule } = makeCtx(
        okMatch,
        vi.fn(async () => ({
          prelude: enc("<html><body>captured</body></html>"),
          postponed: null,
        })),
      );
      (ctx as any).renderToReadableStream = vi.fn(() => {
        getRequestContext()._shellCaptureLoaderRecords?.set(
          "M0D0.app/x#L",
          Promise.resolve({ data: 1 }),
        );
        return emptyStream();
      });

      await runShellCapture(
        ctx,
        new Request("http://localhost/untagged"),
        {},
        new URL("http://localhost/untagged"),
        makeReqCtx(),
        ssrModule,
        {
          key: "/untagged:shell",
          buildVersion: "test-build",
          ttl: 300,
          store: { putShell: makePutShell() } as any,
          debugSink: (event) => events.push(event),
        },
      );

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        outcome: "stored",
        untaggedBake: true,
      });
      expect(describeShellCaptureEvent(events[0]!)).toContain("untagged-bake");

      events.length = 0;
      await runShellCapture(
        ctx,
        new Request("http://localhost/tagged"),
        {},
        new URL("http://localhost/tagged"),
        makeReqCtx(),
        ssrModule,
        {
          key: "/tagged:shell",
          buildVersion: "test-build",
          ttl: 300,
          tags: ["products"],
          store: { putShell: makePutShell() } as any,
          debugSink: (event) => events.push(event),
        },
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.untaggedBake).toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("emits an event per retry attempt and never fails the capture on a throwing sink", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const events: ShellCaptureDebugEvent[] = [];
      const { ctx, ssrModule } = makeCtx(
        okMatch,
        vi.fn(async () => null), // both attempts: no usable shell
      );

      const outcome = await runShellCapture(
        ctx,
        new Request("http://localhost/p"),
        {},
        new URL("http://localhost/p"),
        makeReqCtx(),
        ssrModule,
        {
          key: "/debug-retry:shell",
          buildVersion: "test-build",
          ttl: 300,
          debugSink: (e) => {
            events.push(e);
            throw new Error("sink boom");
          },
        },
        0, // retryDelayMs=0
      );

      expect(outcome).toBe("no-shell");
      expect(events.map((e) => [e.attempt, e.outcome])).toEqual([
        [1, "no-shell"],
        [2, "no-shell"],
      ]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("aborts without storing when the matched route redirects", async () => {
    const putShell = makePutShell();
    const capture = vi.fn(async () => ({
      prelude: enc("<body>x</body>"),
      postponed: null,
    }));
    const { ctx, ssrModule } = makeCtx({ redirect: "/elsewhere" }, capture);

    await runShellCapture(
      ctx,
      new Request("http://localhost/p"),
      {},
      new URL("http://localhost/p"),
      makeReqCtx(),
      ssrModule,
      {
        key: "/p:shell",
        buildVersion: "test-build",
        store: { putShell } as any,
      },
    );

    expect(ssrModule.captureShellHTML).not.toHaveBeenCalled();
    expect(putShell).not.toHaveBeenCalled();
  });

  it("retries once, then stores nothing, when the capture sanity gate refuses twice (null)", async () => {
    const putShell = makePutShell();
    const { ctx, ssrModule } = makeCtx(
      okMatch,
      vi.fn(async () => null),
    );

    await runShellCapture(
      ctx,
      new Request("http://localhost/p"),
      {},
      new URL("http://localhost/p"),
      makeReqCtx(),
      ssrModule,
      {
        key: "/p:shell",
        buildVersion: "test-build",
        store: { putShell } as any,
      },
      0, // retryDelayMs=0: exercise the retry without a real wall-clock wait
    );

    // A `no-shell` first attempt triggers exactly ONE in-place retry.
    expect(ssrModule.captureShellHTML).toHaveBeenCalledTimes(2);
    expect(ctx.router.match).toHaveBeenCalledTimes(2); // fresh match per attempt
    expect(putShell).not.toHaveBeenCalled();
  });

  // Deliverable 1(a): a cold first attempt (null) that the retry heals.
  it("retries a null first attempt and stores when the retry succeeds (putShell once)", async () => {
    const putShell = makePutShell();
    const captureShellHTML = vi
      .fn()
      .mockResolvedValueOnce(null) // attempt 1: cold, no usable shell
      .mockResolvedValueOnce({
        prelude: enc("<html><body>warm</body></html>"),
        postponed: null,
      }); // attempt 2: warm, captured
    const { ctx, ssrModule } = makeCtx(okMatch, captureShellHTML as any);

    await runShellCapture(
      ctx,
      new Request("http://localhost/p"),
      {},
      new URL("http://localhost/p"),
      makeReqCtx(),
      ssrModule,
      {
        key: "/p:shell",
        buildVersion: "test-build",
        ttl: 300,
        store: { putShell } as any,
      },
      0,
    );

    expect(captureShellHTML).toHaveBeenCalledTimes(2);
    expect(putShell).toHaveBeenCalledTimes(1);
    expect(putShell.mock.calls[0]![0]).toBe("/p:shell");
  });

  it("does not retry a genuine AbortError from captureShellHTML", async () => {
    const putShell = makePutShell();
    const abortErr = Object.assign(new Error("component fetch canceled"), {
      name: "AbortError",
    });
    const captureShellHTML = vi.fn().mockRejectedValue(abortErr);
    const { ctx, ssrModule } = makeCtx(okMatch, captureShellHTML as any);

    await expect(
      runShellCapture(
        ctx,
        new Request("http://localhost/p"),
        {},
        new URL("http://localhost/p"),
        makeReqCtx(),
        ssrModule,
        {
          key: "/p:shell",
          buildVersion: "test-build",
          store: { putShell } as any,
        },
        0,
      ),
    ).rejects.toBe(abortErr);

    expect(captureShellHTML).toHaveBeenCalledTimes(1);
    expect(putShell).not.toHaveBeenCalled();
  });

  // Deliverable 1(c): a genuine (non-abort) error is NOT retried — it propagates so
  // scheduleShellCapture reports it once.
  it("does NOT retry a genuine (non-abort) capture error — it propagates (one attempt)", async () => {
    const putShell = makePutShell();
    const captureShellHTML = vi.fn(async () => {
      throw new Error("shell component blew up");
    });
    const { ctx, ssrModule } = makeCtx(okMatch, captureShellHTML as any);

    await expect(
      runShellCapture(
        ctx,
        new Request("http://localhost/p"),
        {},
        new URL("http://localhost/p"),
        makeReqCtx(),
        ssrModule,
        {
          key: "/p:shell",
          buildVersion: "test-build",
          store: { putShell } as any,
        },
        0,
      ),
    ).rejects.toThrow("shell component blew up");

    expect(captureShellHTML).toHaveBeenCalledTimes(1); // no retry
    expect(putShell).not.toHaveBeenCalled();
  });

  // End-to-end proof for the AbortError distinction: once the capture handler
  // lets one escape, the scheduler reports it, does not retry, and backs off.
  it("reports a genuine AbortError once via reportCacheError, then backs the key off", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const captured: Array<() => Promise<void>> = [];
      const abortErr = Object.assign(new Error("component fetch canceled"), {
        name: "AbortError",
      });
      const captureShellHTML = vi.fn().mockRejectedValue(abortErr);
      const { ctx, ssrModule } = makeCtx(okMatch, captureShellHTML as any);
      const reqCtx = makeReqCtx();
      (reqCtx as any).waitUntil = (task: () => Promise<void>) => {
        captured.push(task);
      };
      const request = new Request("http://localhost/err");
      const url = new URL("http://localhost/err");
      const descriptor = {
        key: "/err-genuine:shell",
        buildVersion: "test-build",
        store: { putShell: makePutShell() } as any,
      };

      scheduleShellCapture(
        ctx,
        request,
        {},
        url,
        reqCtx,
        ssrModule,
        descriptor,
      );
      await captured[0]!();

      // No retry: an escaped AbortError is a genuine render failure.
      expect(captureShellHTML).toHaveBeenCalledTimes(1);
      expect(reqCtx._reportBackgroundError).toHaveBeenCalledWith(
        abortErr,
        "cache-write",
      );

      // Backed off: a second schedule within the window is skipped (no new task).
      scheduleShellCapture(
        ctx,
        request,
        {},
        url,
        reqCtx,
        ssrModule,
        descriptor,
      );
      expect(captured).toHaveLength(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  // Deliverable 1(d) + Deliverable 3: both attempts fail → nothing stored, no throw,
  // and the once-per-key warning fires ONLY after the retry (attempt 2) also failed.
  it("both attempts fail: nothing stored, no throw, and warns at most once per key", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const putShell = makePutShell();
    // Unique key: warnedNullCaptures is module-level and persists across tests.
    const key = "/no-loading-once-per-key:shell";

    try {
      for (let i = 0; i < 3; i++) {
        const { ctx, ssrModule } = makeCtx(
          okMatch,
          vi.fn(async () => null),
        );
        await expect(
          runShellCapture(
            ctx,
            new Request("http://localhost/p"),
            {},
            new URL("http://localhost/p"),
            makeReqCtx(),
            ssrModule,
            { key, buildVersion: "test-build", store: { putShell } as any },
            0,
          ),
        ).resolves.toBe("no-shell"); // no throw; terminal outcome is no-shell
        // Each run: two attempts (retry), still nothing stored.
        expect(ssrModule.captureShellHTML).toHaveBeenCalledTimes(2);
      }

      expect(putShell).not.toHaveBeenCalled();
      const keyWarnings = warnSpy.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].includes(key),
      );
      // Deduped to once per key across all three runs.
      expect(keyWarnings).toHaveLength(1);
      // The message names BOTH causes with the distinguishing signal, and the
      // boundary-ownership rule (a child route's loading() does not unpin a
      // parent layout's loaders).
      expect(keyWarnings[0][0]).toContain("Suspense boundary");
      expect(keyWarnings[0][0]).toContain("does not unpin");
      expect(keyWarnings[0][0]).toContain("Cold-start");
      expect(keyWarnings[0][0]).toContain("SELF-HEALS");
    } finally {
      warnSpy.mockRestore();
    }
  });

  // Cold-start does NOT warn: a null first attempt that the retry heals must never
  // reach the once-per-key warning (Deliverable 3 ordering).
  it("does not warn when the retry heals a cold first attempt", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const putShell = makePutShell();
    const key = "/cold-heals-no-warn:shell";
    const captureShellHTML = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        prelude: enc("<html><body>warm</body></html>"),
        postponed: null,
      });
    const { ctx, ssrModule } = makeCtx(okMatch, captureShellHTML as any);

    try {
      await runShellCapture(
        ctx,
        new Request("http://localhost/p"),
        {},
        new URL("http://localhost/p"),
        makeReqCtx(),
        ssrModule,
        { key, buildVersion: "test-build", store: { putShell } as any },
        0,
      );
      expect(putShell).toHaveBeenCalledTimes(1);
      const keyWarnings = warnSpy.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].includes(key),
      );
      expect(keyWarnings).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("stampede guard: a second schedule for the same in-flight key is skipped, then allowed after it settles", async () => {
    const captured: Array<() => Promise<void>> = [];
    // A valid (stored) capture so the task settles in one attempt — this test is
    // about the stampede guard / key lifecycle, not the retry path.
    const { ctx, ssrModule } = makeCtx(
      okMatch,
      vi.fn(async () => ({
        prelude: enc("<body>x</body>"),
        postponed: null,
      })),
    );
    const reqCtx = makeReqCtx();
    // Capture the background task instead of running it, so the key stays
    // in-flight until we drain it deterministically.
    (reqCtx as any).waitUntil = (task: () => Promise<void>) => {
      captured.push(task);
    };
    const request = new Request("http://localhost/hot");
    const url = new URL("http://localhost/hot");
    const descriptor = {
      key: "/hot:shell",
      buildVersion: "test-build",
      store: { putShell: makePutShell() } as any,
    };

    scheduleShellCapture(ctx, request, {}, url, reqCtx, ssrModule, descriptor);
    // Same key in-flight → skipped.
    scheduleShellCapture(ctx, request, {}, url, reqCtx, ssrModule, descriptor);
    expect(captured).toHaveLength(1);

    // Drain the first task (its finally clears the in-flight key).
    await captured[0]!();

    // Key released → a later schedule for the same key runs again.
    scheduleShellCapture(ctx, request, {}, url, reqCtx, ssrModule, descriptor);
    expect(captured).toHaveLength(2);
    await captured[1]!();
  });

  it("wraps the background capture in ONE rango.background span (kind=shell-capture), inner phase spans suppressed", async () => {
    const captured: Array<() => Promise<void>> = [];
    const putShell = makePutShell();
    const { ctx, ssrModule } = makeCtx(
      okMatch,
      vi.fn(async () => ({
        prelude: enc("<body>x</body>"),
        postponed: null,
      })),
    );
    const reqCtx = makeReqCtx();
    const spans: Array<{
      name: string;
      attributes: Record<string, unknown>;
    }> = [];
    (reqCtx as any)._tracing = resolveTracing({
      runner: (name, fn) => {
        const record = { name, attributes: {} as Record<string, unknown> };
        spans.push(record);
        return fn({
          setAttribute(k, v) {
            record.attributes[k] = v;
          },
        });
      },
    });
    (reqCtx as any).waitUntil = (task: () => Promise<void>) => {
      captured.push(task);
    };
    const request = new Request("http://localhost/span");
    const url = new URL("http://localhost/span");

    scheduleShellCapture(ctx, request, {}, url, reqCtx, ssrModule, {
      key: "/span:shell",
      buildVersion: "test-build",
      store: { putShell } as any,
    });

    expect(captured).toHaveLength(1);
    // No span until the task actually runs.
    expect(spans).toHaveLength(0);
    // Production propagates the request ALS into the waitUntil continuation;
    // the harness intercepts waitUntil, so re-establish it around the drain.
    await runWithRequestContext(reqCtx as any, () => captured[0]!());

    expect(putShell).toHaveBeenCalledTimes(1);
    // Exactly ONE span — the wrapper. The capture's inner phase spans stay
    // suppressed (deriveShellCaptureContext strips _tracing), so the capture
    // re-render must NOT add a duplicate rango.ssr/render/loader set.
    expect(spans.map((s) => s.name)).toEqual(["rango.background"]);
    const attrs = spans[0].attributes;
    expect(attrs["rango.background.kind"]).toBe("shell-capture");
    expect(attrs["rango.shell_key"]).toBe("/span:shell");
    expect(attrs["rango.background.outcome"]).toBe("stored");
    expect(typeof attrs["rango.background.queue_wait_ms"]).toBe("number");
  });

  it("loads a lazy SSR module only inside the background capture task", async () => {
    const captured: Array<() => Promise<void>> = [];
    const putShell = makePutShell();
    const { ctx, ssrModule } = makeCtx(
      okMatch,
      vi.fn(async () => ({
        prelude: enc("<body>x</body>"),
        postponed: null,
      })),
    );
    const loadSSRModule = vi.fn(async () => ssrModule);
    const reqCtx = makeReqCtx();
    (reqCtx as any).waitUntil = (task: () => Promise<void>) => {
      captured.push(task);
    };
    const request = new Request(
      "http://localhost/lazy?_rsc_partial=true&_rsc_segments=L0",
    );
    const url = new URL(request.url);

    scheduleShellCapture(ctx, request, {}, url, reqCtx, loadSSRModule, {
      key: "/lazy:shell:navigation",
      buildVersion: "test-build",
      store: { putShell } as any,
      navigationOnly: true,
    });

    expect(loadSSRModule).not.toHaveBeenCalled();
    expect(captured).toHaveLength(1);
    await captured[0]!();
    expect(loadSSRModule).toHaveBeenCalledTimes(1);
    expect(putShell).toHaveBeenCalledTimes(1);
  });

  // Deliverable 8: refused-capture backoff. A key that produced no usable shell
  // after the in-place retry is negatively cached for a window, so an ineligible
  // route (no loading(), cookie-reading handler) mounted app-wide does not
  // reschedule a doomed background render on every request. Fake timers control
  // both the retry delay and the 60s window.
  it("backs off a refused key: no re-schedule within the window, re-probes after expiry", async () => {
    vi.useFakeTimers();
    try {
      const captured: Array<() => Promise<void>> = [];
      const captureShellHTML = vi.fn(async () => null);
      const { ctx, ssrModule } = makeCtx(okMatch, captureShellHTML as any);
      const reqCtx = makeReqCtx();
      (reqCtx as any).waitUntil = (task: () => Promise<void>) => {
        captured.push(task);
      };
      const request = new Request("http://localhost/bo1");
      const url = new URL("http://localhost/bo1");
      const descriptor = {
        key: "/bo1-backoff:shell",
        buildVersion: "test-build",
        store: { putShell: makePutShell() } as any,
      };

      // 1st schedule: runs both attempts (retry), both null → marks backoff.
      scheduleShellCapture(
        ctx,
        request,
        {},
        url,
        reqCtx,
        ssrModule,
        descriptor,
      );
      expect(captured).toHaveLength(1);
      const t1 = captured[0]!();
      await vi.runAllTimersAsync(); // flush the in-place retry delay
      await t1;
      expect(captureShellHTML).toHaveBeenCalledTimes(2);

      // 2nd schedule within the 60s window: skipped (no new background task).
      scheduleShellCapture(
        ctx,
        request,
        {},
        url,
        reqCtx,
        ssrModule,
        descriptor,
      );
      expect(captured).toHaveLength(1);

      // Past the window: re-probed.
      vi.setSystemTime(Date.now() + 120_000); // well past the (exponential) backoff window
      scheduleShellCapture(
        ctx,
        request,
        {},
        url,
        reqCtx,
        ssrModule,
        descriptor,
      );
      expect(captured).toHaveLength(2);
      const t2 = captured[1]!();
      await vi.runAllTimersAsync();
      await t2;
    } finally {
      vi.useRealTimers();
    }
  });

  it("a successful capture clears the refused-key backoff", async () => {
    vi.useFakeTimers();
    try {
      const captured: Array<() => Promise<void>> = [];
      const reqCtx = makeReqCtx();
      (reqCtx as any).waitUntil = (task: () => Promise<void>) => {
        captured.push(task);
      };
      const request = new Request("http://localhost/bo2");
      const url = new URL("http://localhost/bo2");
      const putShell = makePutShell();
      const descriptor = {
        key: "/bo2-backoff:shell",
        buildVersion: "test-build",
        store: { putShell } as any,
      };

      // Refuse → backoff.
      const nullMod = makeCtx(
        okMatch,
        vi.fn(async () => null),
      );
      scheduleShellCapture(
        nullMod.ctx,
        request,
        {},
        url,
        reqCtx,
        nullMod.ssrModule,
        descriptor,
      );
      const t1 = captured[0]!();
      await vi.runAllTimersAsync();
      await t1;

      // Within the window scheduling is skipped.
      scheduleShellCapture(
        nullMod.ctx,
        request,
        {},
        url,
        reqCtx,
        nullMod.ssrModule,
        descriptor,
      );
      expect(captured).toHaveLength(1);

      // Past the window a VALID capture stores AND clears the backoff.
      vi.setSystemTime(Date.now() + 120_000); // well past the (exponential) backoff window
      const okMod = makeCtx(
        okMatch,
        vi.fn(async () => ({
          prelude: enc("<body>x</body>"),
          postponed: null,
        })),
      );
      scheduleShellCapture(
        okMod.ctx,
        request,
        {},
        url,
        reqCtx,
        okMod.ssrModule,
        descriptor,
      );
      expect(captured).toHaveLength(2);
      const t2 = captured[1]!();
      await vi.runAllTimersAsync();
      await t2;
      expect(putShell).toHaveBeenCalledTimes(1);

      // Backoff cleared: an immediate re-schedule runs right away (no lingering
      // negative entry), even for a would-be-refusing module.
      scheduleShellCapture(
        nullMod.ctx,
        request,
        {},
        url,
        reqCtx,
        nullMod.ssrModule,
        descriptor,
      );
      expect(captured).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  // Deliverable 9(a): the middleware's operational `tags` option (threaded on the
  // descriptor) is UNIONED with the render-collected non-loader tags in putShell.
  it("unions option tags (descriptor.tags) with the render-collected tags into putShell", async () => {
    const putShell = makePutShell();
    const { ctx, ssrModule } = makeCtx(
      okMatch,
      vi.fn(async () => ({ prelude: enc("<body>x</body>"), postponed: null })),
    );
    // The capture render records a tag on its derived context's _requestTags (as a
    // cacheTag / cache() read would). Simulate that side effect in the Flight render.
    (ctx as any).renderToReadableStream = vi.fn(() => {
      getRequestContext()._requestTags.add("collected:y");
      return emptyStream();
    });

    await runShellCapture(
      ctx,
      new Request("http://localhost/p"),
      {},
      new URL("http://localhost/p"),
      makeReqCtx(),
      ssrModule,
      {
        key: "/p:shell",
        buildVersion: "test-build",
        store: { putShell } as any,
        tags: ["op:x"],
      },
      0,
    );

    expect(putShell).toHaveBeenCalledTimes(1);
    const tags = putShell.mock.calls[0]![4];
    // Both the operational option tag and the render-collected tag are present.
    expect(new Set(tags)).toEqual(new Set(["op:x", "collected:y"]));
  });

  // #648: the render-callable cacheTag() form. A server component in the shell
  // tree calls cacheTag("shell-op") (no cache()/"use cache" wrapping it). Under
  // capture it records onto the derived context's fresh _requestTags, which the
  // capture unions into the shell entry — so revalidateTag("shell-op") drops the
  // shell. Unions with the static ppr.tags (descriptor.tags) the same way.
  it("records a render-called cacheTag() into the shell entry tags, unioned with ppr.tags (#648)", async () => {
    const putShell = makePutShell();
    const { ctx, ssrModule } = makeCtx(
      okMatch,
      vi.fn(async () => ({ prelude: enc("<body>x</body>"), postponed: null })),
    );
    // The shell render calls the REAL render-callable cacheTag (before #648 this
    // threw outside a "use cache" scope — the gap the issue closes).
    (ctx as any).renderToReadableStream = vi.fn(() => {
      cacheTag("shell-op");
      return emptyStream();
    });

    await runShellCapture(
      ctx,
      new Request("http://localhost/p"),
      {},
      new URL("http://localhost/p"),
      makeReqCtx(),
      ssrModule,
      {
        key: "/p:shell",
        buildVersion: "test-build",
        store: { putShell } as any,
        tags: ["ppr:static"],
      },
      0,
    );

    expect(putShell).toHaveBeenCalledTimes(1);
    const tags = new Set(putShell.mock.calls[0]![4]);
    expect(tags).toEqual(new Set(["ppr:static", "shell-op"]));
  });

  // #648 invariant, by construction: baked ⇒ evicts, hole ⇒ fresh. A bake-lane
  // server component EXECUTES during capture and tags the shell; a subtree behind
  // a renderable loading() is MASKED (its loaders never run at capture), so its
  // cacheTag never fires and nothing under a hole can tag the shell. The harness
  // pins the bake-lane side directly (the executed cacheTag lands) and the hole
  // side by construction (the masked loader's cacheTag is simply never invoked,
  // so its tag is absent) — there is no filtering logic to test, only execution.
  it("shell entry tags carry only what the capture render executed — hole tags never reach it (#648)", async () => {
    const putShell = makePutShell();
    const { ctx, ssrModule } = makeCtx(
      okMatch,
      vi.fn(async () => ({ prelude: enc("<body>x</body>"), postponed: null })),
    );
    (ctx as any).renderToReadableStream = vi.fn(() => {
      // Bake lane: executes during capture, records onto the shell's tag set.
      cacheTag("baked-shell");
      // A masked hole loader would cacheTag("hole-tag"), but masking means it is
      // never called during capture — so the call below is intentionally absent.
      return emptyStream();
    });

    await runShellCapture(
      ctx,
      new Request("http://localhost/p"),
      {},
      new URL("http://localhost/p"),
      makeReqCtx(),
      ssrModule,
      {
        key: "/p:shell",
        buildVersion: "test-build",
        store: { putShell } as any,
      },
      0,
    );

    expect(putShell).toHaveBeenCalledTimes(1);
    const tags = new Set(putShell.mock.calls[0]![4]);
    expect(tags.has("baked-shell")).toBe(true);
    expect(tags.has("hole-tag")).toBe(false);
  });

  // #648: a tag present BOTH as a static ppr.tags entry (descriptor.tags) AND
  // recorded by the render collapses to ONE stored tag (Set union), never a
  // duplicate on the entry.
  it("dedupes a tag present both statically and via render-record into a single stored tag (#648)", async () => {
    const putShell = makePutShell();
    const { ctx, ssrModule } = makeCtx(
      okMatch,
      vi.fn(async () => ({ prelude: enc("<body>x</body>"), postponed: null })),
    );
    (ctx as any).renderToReadableStream = vi.fn(() => {
      cacheTag("dup");
      return emptyStream();
    });

    await runShellCapture(
      ctx,
      new Request("http://localhost/p"),
      {},
      new URL("http://localhost/p"),
      makeReqCtx(),
      ssrModule,
      {
        key: "/p:shell",
        buildVersion: "test-build",
        store: { putShell } as any,
        tags: ["dup"],
      },
      0,
    );

    expect(putShell.mock.calls[0]![4]).toEqual(["dup"]);
  });

  // #648 full round-trip: a render-recorded tag on the captured shell makes the
  // entry evictable through the store's tag invalidation — proving the collected
  // tag reaches the stored entry AND wires up to revalidateTag/updateTag.
  it("a render-recorded tag makes the captured shell evictable via the store (#648)", async () => {
    const store = new MemorySegmentCacheStore();
    const { ctx, ssrModule } = makeCtx(
      okMatch,
      vi.fn(async () => ({
        prelude: enc("<html><body>x</body></html>"),
        postponed: null,
      })),
    );
    (ctx as any).renderToReadableStream = vi.fn(() => {
      cacheTag("evictable-shell");
      return emptyStream();
    });
    const reqCtx = makeReqCtx();
    (reqCtx as any)._cacheStore = store;

    await runShellCapture(
      ctx,
      new Request("http://localhost/p"),
      {},
      new URL("http://localhost/p"),
      reqCtx,
      ssrModule,
      { key: "/p:shell", buildVersion: "test-build", ttl: 300, store },
      0,
    );

    // Captured and reachable.
    expect(await store.getShell("/p:shell")).not.toBeNull();
    // The render-recorded tag drops it.
    await store.invalidateTags(["evictable-shell"]);
    expect(await store.getShell("/p:shell")).toBeNull();
  });

  // #676: a cacheTag() recorded AFTER an await inside an async shell server
  // component. React renders the synchronous tree during RSC-stream construction,
  // so a sync cacheTag lands; a tag recorded on a later microtask/macrotask (past
  // the await) lands after construction. The shell tag snapshot now sits at the
  // putShell WRITE BARRIER — after the capture quiesces — so the late tag is
  // collected, unioned with the static ppr.tags, and revalidateTag() evicts the
  // shell. captureShellHTML gates on the same promise the component awaits, so the
  // tag records within the capture's quiesce window (the real async component the
  // shell waits for).
  it("collects a cacheTag() recorded after an await in async shell content (#676)", async () => {
    const putShell = makePutShell();
    let recorded: Promise<void> = Promise.resolve();
    const { ctx, ssrModule } = makeCtx(
      okMatch,
      vi.fn(async () => {
        await recorded;
        return { prelude: enc("<body>x</body>"), postponed: null };
      }),
    );
    (ctx as any).renderToReadableStream = vi.fn(() => {
      recorded = (async () => {
        await new Promise((r) => setTimeout(r, 0));
        cacheTag("async-shell-tag");
      })();
      return emptyStream();
    });

    await runShellCapture(
      ctx,
      new Request("http://localhost/p"),
      {},
      new URL("http://localhost/p"),
      makeReqCtx(),
      ssrModule,
      {
        key: "/p:shell",
        buildVersion: "test-build",
        store: { putShell } as any,
        tags: ["ppr:static"],
      },
      0,
    );

    expect(putShell).toHaveBeenCalledTimes(1);
    const tags = new Set(putShell.mock.calls[0]![4]);
    expect(tags).toEqual(new Set(["ppr:static", "async-shell-tag"]));
  });

  // #676 (async "use cache" propagation): a "use cache" read that HITs during the
  // capture render propagates its entry tags to the document artifact via the
  // cache runtime's recordRequestTags(entry.tags) — and an async cached function
  // records them AFTER its await resolves. Simulate that timing: the render kicks
  // off a delayed continuation that recordRequestTags() after an await, gated the
  // same way the cache read-HIT test gates on the read. The late tag must reach
  // the stored entry, same as the render-callable cacheTag form above.
  it("collects an async use-cache read's tags recorded after an await (#676)", async () => {
    const putShell = makePutShell();
    let recorded: Promise<void> = Promise.resolve();
    const { ctx, ssrModule } = makeCtx(
      okMatch,
      vi.fn(async () => {
        await recorded;
        return { prelude: enc("<body>x</body>"), postponed: null };
      }),
    );
    (ctx as any).renderToReadableStream = vi.fn(() => {
      const reqCtx = getRequestContext();
      recorded = (async () => {
        await new Promise((r) => setTimeout(r, 0));
        // What cache-runtime.ts does on a "use cache" read-HIT: propagate the
        // resolved entry's tags to the request's document artifact.
        recordRequestTags(["async-use-cache-tag"], reqCtx);
      })();
      return emptyStream();
    });

    await runShellCapture(
      ctx,
      new Request("http://localhost/p"),
      {},
      new URL("http://localhost/p"),
      makeReqCtx(),
      ssrModule,
      {
        key: "/p:shell",
        buildVersion: "test-build",
        store: { putShell } as any,
      },
      0,
    );

    expect(putShell).toHaveBeenCalledTimes(1);
    const tags = new Set(putShell.mock.calls[0]![4]);
    expect(tags.has("async-use-cache-tag")).toBe(true);
  });

  // Capture data snapshot: a cache read-HIT the capture render performs through
  // the ambient (recording) store is recorded onto entry.snapshot, so a HIT can
  // replay it and match the frozen prelude. See cache/shell-snapshot.ts.
  it("records a cache read-HIT performed during the capture render into entry.snapshot", async () => {
    const store = new MemorySegmentCacheStore();
    await store.setItem("use-cache:x", "CAPVAL", { ttl: 60, tags: ["t1"] });
    const putShell = vi.spyOn(store, "putShell");

    // Model the shell "use cache" read: the render reads the item through the
    // ambient store (which, under capture, is the recording wrapper). The shell
    // only quiesces once that read resolves, so captureShellHTML awaits it.
    let readDone: Promise<unknown> = Promise.resolve();
    const { ctx, ssrModule } = makeCtx(
      okMatch,
      vi.fn(async () => {
        await readDone;
        return { prelude: enc("<html><body>x</body></html>"), postponed: null };
      }),
    );
    (ctx as any).renderToReadableStream = () => {
      readDone = getRequestContext()._cacheStore!.getItem!("use-cache:x");
      return emptyStream();
    };
    const reqCtx = makeReqCtx();
    (reqCtx as any)._cacheStore = store;

    await runShellCapture(
      ctx,
      new Request("http://localhost/p"),
      {},
      new URL("http://localhost/p"),
      reqCtx,
      ssrModule,
      { key: "/p:shell", buildVersion: "test-build", ttl: 300, store },
      0,
    );

    expect(putShell).toHaveBeenCalledTimes(1);
    const entry = putShell.mock.calls[0]![1];
    expect(entry.snapshot).toBeDefined();
    const rec = entry.snapshot!.find((r) => r.key === "use-cache:x")!;
    expect(rec.family).toBe("item");
    expect((rec.value as any).value).toBe("CAPVAL");
    expect((rec.value as any).tags).toEqual(["t1"]);
    // The shared foreground store is untouched by the recording wrapper.
    expect((reqCtx as any)._cacheStore).toBe(store);
  });

  it("leaves entry.snapshot undefined when the capture render touches no cache store", async () => {
    const store = new MemorySegmentCacheStore();
    const putShell = vi.spyOn(store, "putShell");
    const { ctx, ssrModule } = makeCtx(
      okMatch,
      vi.fn(async () => ({
        prelude: enc("<html><body>x</body></html>"),
        postponed: null,
      })),
    );
    const reqCtx = makeReqCtx();
    (reqCtx as any)._cacheStore = store;

    await runShellCapture(
      ctx,
      new Request("http://localhost/p"),
      {},
      new URL("http://localhost/p"),
      reqCtx,
      ssrModule,
      { key: "/p:shell", buildVersion: "test-build", store },
      0,
    );

    expect(putShell).toHaveBeenCalledTimes(1);
    expect(putShell.mock.calls[0]![1].snapshot).toBeUndefined();
  });

  // WRITE BARRIER (the mini shell-manifest clobber regression): the capture must
  // settle the foreground's already-scheduled background tasks — its deferred
  // ring-3/ring-1 cache writes — BEFORE matching, so its cache reads observe the
  // foreground's generation deterministically instead of racing the write. A
  // capture that raced and MISSed would re-execute the route handler (bumping
  // module-level state) and, via the synthetic onResponse fire, overwrite the
  // foreground's ring-3 entry with its own re-render (last-write-wins clobber).
  it("write barrier: settles foreground waitUntil tasks (incl. nested) before the capture match", async () => {
    const putShell = makePutShell();
    const order: string[] = [];
    const reqCtx = makeReqCtx();

    // Foreground deferred cache write, scheduled BEFORE the capture (the real
    // shape: onResponse -> waitUntil(cacheRoute) -> nested waitUntil(store.set)).
    reqCtx.waitUntil(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("outer-write");
      // Nested write scheduled from inside the settling task (cacheRoute's
      // actual store.set) — the drain must pick it up iteratively.
      reqCtx.waitUntil(async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push("nested-write");
      });
    });

    const { ctx, ssrModule } = makeCtx(
      okMatch,
      vi.fn(async () => ({
        prelude: enc("<html><body>x</body></html>"),
        postponed: null,
      })),
    );
    const originalMatch = ctx.router.match;
    (ctx.router as any).match = vi.fn(async (request: Request, opts: any) => {
      order.push("capture-match");
      return originalMatch(request, opts);
    });

    await runShellCapture(
      ctx,
      new Request("http://localhost/p"),
      {},
      new URL("http://localhost/p"),
      reqCtx,
      ssrModule,
      {
        key: "/p:shell",
        buildVersion: "test-build",
        store: { putShell } as any,
      },
      0,
    );

    // Both foreground writes settled BEFORE the capture's match — the ordering
    // edge, not a narrower get-before-set race.
    expect(order).toEqual(["outer-write", "nested-write", "capture-match"]);
    expect(putShell).toHaveBeenCalledTimes(1);
  });

  it("write barrier is bounded: a hung foreground task does not stall the capture past the deadline", async () => {
    vi.useFakeTimers();
    try {
      const putShell = makePutShell();
      const reqCtx = makeReqCtx();
      // A tracked task that never settles (pathological consumer waitUntil).
      reqCtx.waitUntil(() => new Promise<void>(() => {}));

      const { ctx, ssrModule } = makeCtx(
        okMatch,
        vi.fn(async () => ({
          prelude: enc("<html><body>x</body></html>"),
          postponed: null,
        })),
      );

      const run = runShellCapture(
        ctx,
        new Request("http://localhost/p"),
        {},
        new URL("http://localhost/p"),
        reqCtx,
        ssrModule,
        {
          key: "/p:shell",
          buildVersion: "test-build",
          store: { putShell } as any,
        },
        0,
      );
      await vi.runAllTimersAsync(); // fires the barrier's deadline guard
      await run;

      // The capture proceeded (degraded to the pre-barrier behavior) instead of
      // hanging on the stuck task.
      expect(putShell).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not mask via _shellCaptureRun on the caller's foreground context", async () => {
    // runShellCapture sets _shellCaptureRun only on its DERIVED context; the
    // passed foreground reqCtx must be left untouched.
    const putShell = makePutShell();
    const { ctx, ssrModule } = makeCtx(
      okMatch,
      vi.fn(async () => ({ prelude: enc("<body>x</body>"), postponed: null })),
    );
    const reqCtx = makeReqCtx();

    await runShellCapture(
      ctx,
      new Request("http://localhost/p"),
      {},
      new URL("http://localhost/p"),
      reqCtx,
      ssrModule,
      {
        key: "/p:shell",
        buildVersion: "test-build",
        store: { putShell } as any,
      },
    );

    expect((reqCtx as any)._shellCaptureRun).toBeUndefined();
  });
});

// Refused-capture backoff policy (#652 item 3). markCaptureBackoff escalates the
// window exponentially per consecutive failure, clamped to the mode's ceiling: 60s
// in production (a genuinely ineligible route should be re-probed rarely), but only
// REFUSED_CAPTURE_DEV_MAX_MS (~2s) in dev, where the dominant no-shell cause is a
// COLD module graph that WARMS on the very attempt that failed. The dev cap is the
// fix for the cloudflare-basic-e2e cold-CI failure: the 60s exponential outlasts
// the e2e warm window, freezing every subsequent request as backed-off (eternal
// MISS) even though the modules are warm by then. These tests drive the exported
// backoff functions directly so the exact window arithmetic is pinned.
//
// NODE_ENV under the unit vitest config defaults to "test" (dev mode) — so the
// dev-cap tests need no override; the production-growth test sets it explicitly.
describe("refused-capture backoff policy", () => {
  // Backoff state is part of the debug-sink surface (issue #651): a request
  // that skips the capture because the key is inside its window emits a
  // skip-backoff event carrying the failure count and remaining window.
  it("scheduleShellCapture emits a skip-backoff debug event with the backoff state", () => {
    const key = "/skip-backoff-event:shell";
    clearCaptureBackoff(key);
    try {
      markCaptureBackoff(key);
      const events: ShellCaptureDebugEvent[] = [];
      scheduleShellCapture(
        {} as any,
        new Request("http://localhost/p"),
        {},
        new URL("http://localhost/p"),
        {} as any,
        {} as any,
        {
          key,
          buildVersion: "test-build",
          debugSink: (e) => events.push(e),
        },
      );
      expect(events).toHaveLength(1);
      expect(events[0].outcome).toBe("skip-backoff");
      expect(events[0].backoffFailures).toBe(1);
      expect(events[0].backoffRemainingMs).toBeGreaterThan(0);
      expect(events[0].backoffRemainingMs).toBeLessThanOrEqual(
        REFUSED_CAPTURE_DEV_MAX_MS,
      );
    } finally {
      clearCaptureBackoff(key);
    }
  });

  it("dev cap: the window never exceeds REFUSED_CAPTURE_DEV_MAX_MS however high the failure count climbs", () => {
    vi.useFakeTimers();
    try {
      const key = "/dev-cap-window:shell";
      clearCaptureBackoff(key);
      const t0 = Date.now();
      // Five consecutive failures at the same instant: the exponential term
      // (1000*2^4 = 16000) would blow past the cap, so the window clamps to the
      // dev ceiling (2000).
      for (let i = 0; i < 5; i++) markCaptureBackoff(key);

      // Just before the cap elapses: still backed off.
      vi.setSystemTime(t0 + REFUSED_CAPTURE_DEV_MAX_MS - 1);
      expect(isCaptureBackedOff(key)).toBe(true);
      // At the cap: the window has elapsed — a re-probe is allowed. This is the
      // whole point: the dev window is bounded at ~2s, not the 16s the raw
      // exponential (or the 60s prod cap) would give.
      vi.setSystemTime(t0 + REFUSED_CAPTURE_DEV_MAX_MS);
      expect(isCaptureBackedOff(key)).toBe(false);
    } finally {
      clearCaptureBackoff("/dev-cap-window:shell");
      vi.useRealTimers();
    }
  });

  it("production: exponential growth is intact (window exceeds the dev cap and climbs to 60s)", () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    vi.useFakeTimers();
    try {
      const key = "/prod-grow-window:shell";
      clearCaptureBackoff(key);
      const t0 = Date.now();
      // Five failures → min(1000*2^4, 60000) = 16000ms, far past the 2s dev cap.
      for (let i = 0; i < 5; i++) markCaptureBackoff(key);
      // Still backed off well past where dev would have cleared (2s) — proof the
      // dev cap does NOT leak into production.
      vi.setSystemTime(t0 + REFUSED_CAPTURE_DEV_MAX_MS + 1);
      expect(isCaptureBackedOff(key)).toBe(true);
      vi.setSystemTime(t0 + 15_999);
      expect(isCaptureBackedOff(key)).toBe(true);
      vi.setSystemTime(t0 + 16_000);
      expect(isCaptureBackedOff(key)).toBe(false);

      // Many more failures ramp to — and clamp at — the 60s production ceiling.
      clearCaptureBackoff(key);
      const t1 = Date.now();
      for (let i = 0; i < 12; i++) markCaptureBackoff(key); // 1000*2^11 >> 60000
      vi.setSystemTime(t1 + 59_999);
      expect(isCaptureBackedOff(key)).toBe(true);
      vi.setSystemTime(t1 + 60_000);
      expect(isCaptureBackedOff(key)).toBe(false);
    } finally {
      clearCaptureBackoff("/prod-grow-window:shell");
      process.env.NODE_ENV = original;
      vi.useRealTimers();
    }
  });

  it("a stored capture clears the backoff (failure count resets)", () => {
    vi.useFakeTimers();
    try {
      const key = "/stored-clears:shell";
      clearCaptureBackoff(key);
      const t0 = Date.now();
      markCaptureBackoff(key);
      expect(isCaptureBackedOff(key)).toBe(true);
      // A subsequent capture that STORES clears the entry outright — the next
      // request probes immediately, and any later failure starts the exponential
      // over from BASE (not from the escalated count).
      clearCaptureBackoff(key);
      expect(isCaptureBackedOff(key)).toBe(false);
      markCaptureBackoff(key); // failure count reset to 1 → BASE window (1000)
      vi.setSystemTime(t0 + 1_000);
      expect(isCaptureBackedOff(key)).toBe(false);
    } finally {
      clearCaptureBackoff("/stored-clears:shell");
      vi.useRealTimers();
    }
  });

  // Regression pin for the cold-CI failure (#652 item 3; main run 2586ea9c and the
  // PR #657 runs). Walk the EXACT e2e cadence: a first capture fails at t0, then
  // warmToHit polls once per second for 20s. On a persistently-cold CI runner every
  // probe ALSO fails, climbing the failure count. Under the dev cap the window stays
  // ≤2s, so the LATE part of the 20s window still admits probes — the route is never
  // frozen out. Non-vacuous: without the dev cap (production exponential, asserted in
  // the sibling test below) the window blows past 20s after a handful of failures and
  // the tail of the poll admits ZERO probes — the eternal MISS the test hit.
  function walkColdCiWindow(): { probes: number; tailProbes: number } {
    const key = "/cold-ci-sequence:shell";
    clearCaptureBackoff(key);
    const t0 = Date.now();
    markCaptureBackoff(key); // t0: first capture attempt failed (post-retry)
    let probes = 0;
    let tailProbes = 0; // probes in the last 4s of the 20s window (s = 17..20)
    for (let s = 1; s <= 20; s++) {
      vi.setSystemTime(t0 + s * 1_000);
      if (!isCaptureBackedOff(key)) {
        probes += 1;
        if (s >= 17) tailProbes += 1;
        markCaptureBackoff(key); // this probe was also cold → re-marks (climbs)
      }
    }
    clearCaptureBackoff(key);
    return { probes, tailProbes };
  }

  it("simulated cold start: the dev cap keeps re-probing across the full 20s warm window", () => {
    vi.useFakeTimers();
    try {
      const { probes, tailProbes } = walkColdCiWindow();
      // ~10 probes across 20s (one roughly every 2s), and crucially the tail of
      // the window is NOT frozen out — the CI test would see a HIT the moment one
      // of these warm re-probes captures.
      expect(probes).toBeGreaterThanOrEqual(8);
      expect(tailProbes).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("without the dev cap (production) the same cold sequence freezes the tail of the warm window — the bug being fixed", () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    vi.useFakeTimers();
    try {
      const { tailProbes } = walkColdCiWindow();
      // The 60s exponential escalates past 20s after ~4 failures, so the last 4s
      // of the poll admit no probe — every request is skipped as backed-off. This
      // is exactly the eternal MISS the dev cap removes.
      expect(tailProbes).toBe(0);
    } finally {
      process.env.NODE_ENV = original;
      vi.useRealTimers();
    }
  });
});

// Wedge containment (autobarn pilot outage): a capture whose render never
// settles must not strand the stampede guard or the capture queue. Two layers,
// both pinned here: the task hard cap (raceTaskHardCap around runShellCapture)
// bounds a live-context wedge — SHELL_CAPTURE_MAX_WAIT_MS arms only AFTER the
// capture's router.match(), so a handler wedged on a never-settling upstream
// await had no deadline at all; and the guard's staleness reclaim +
// token-guarded release heal a killed-context stranding where no timer
// survives to fire.
describe("capture task hard cap + stampede-guard staleness", () => {
  function makeWedgedCtx(): HandlerContext<any> {
    return {
      version: "v-test",
      router: { match: vi.fn(() => new Promise<never>(() => {})) },
      callOnError: vi.fn(),
      renderToReadableStream: vi.fn(),
    } as unknown as HandlerContext<any>;
  }

  function makeScheduleReqCtx(
    captured: Array<() => Promise<void>>,
  ): RequestContext {
    const reqCtx = createRequestContext({
      env: {},
      request: new Request("http://localhost/wedge"),
      url: new URL("http://localhost/wedge"),
      variables: {},
    }) as RequestContext;
    (reqCtx as any)._reportBackgroundError = vi.fn();
    (reqCtx as any).waitUntil = (task: () => Promise<void>) => {
      captured.push(task);
    };
    return reqCtx;
  }

  function validSsr(): SSRModule {
    return {
      renderHTML: vi.fn(),
      resumeShellHTML: vi.fn(),
      captureShellHTML: vi.fn(),
    } as unknown as SSRModule;
  }

  it("hard cap: a capture wedged in router.match settles at the cap, backs off, and releases the guard", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const key = "/wedge-hard-cap:shell";
      const captured: Array<() => Promise<void>> = [];
      const ctx = makeWedgedCtx();
      const reqCtx = makeScheduleReqCtx(captured);
      const descriptor = {
        key,
        buildVersion: "test-build",
        store: { putShell: vi.fn() } as any,
      };
      const schedule = () =>
        scheduleShellCapture(
          ctx,
          new Request("http://localhost/wedge"),
          {},
          new URL("http://localhost/wedge"),
          reqCtx,
          validSsr(),
          descriptor,
        );

      schedule();
      expect(captured).toHaveLength(1);

      const task = captured[0]!();
      // Let the task reach the wedged match, then fire the hard cap.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(SHELL_CAPTURE_TASK_HARD_CAP_MS + 1);
      await task; // settles via the catch path — the fix under test

      expect(reqCtx._reportBackgroundError).toHaveBeenCalledTimes(1);
      const [reported, category] = (reqCtx._reportBackgroundError as any).mock
        .calls[0];
      expect(String(reported)).toContain("hard cap");
      expect(category).toBe("cache-write");
      // The wedge backs the key off: a wedging route is not re-probed on
      // every request.
      expect(isCaptureBackedOff(key)).toBe(true);

      // The settle path released the guard: clear the backoff and a new
      // schedule is admitted rather than skipped as in-flight.
      clearCaptureBackoff(key);
      schedule();
      expect(captured).toHaveLength(2);
    } finally {
      vi.useRealTimers();
      errSpy.mockRestore();
    }
  });

  it("staleness reclaim: a guard entry stranded by a killed context is reclaimed past the cap", async () => {
    vi.useFakeTimers();
    try {
      const key = "/wedge-stale-guard:shell";
      const events: ShellCaptureDebugEvent[] = [];
      const captured: Array<() => Promise<void>> = [];
      const ctx = makeWedgedCtx();
      const reqCtx = makeScheduleReqCtx(captured);
      const descriptor = {
        key,
        buildVersion: "test-build",
        store: { putShell: vi.fn() } as any,
        debugSink: (e: ShellCaptureDebugEvent) => events.push(e),
      };
      const schedule = () =>
        scheduleShellCapture(
          ctx,
          new Request("http://localhost/wedge"),
          {},
          new URL("http://localhost/wedge"),
          reqCtx,
          validSsr(),
          descriptor,
        );

      // Schedule but never run the task: the guard entry exists and nothing
      // will ever release it — exactly a capture whose workerd context was
      // killed before its settle paths (including the cap timer) could run.
      schedule();
      expect(captured).toHaveLength(1);

      // Fresh entry: a concurrent schedule coalesces.
      schedule();
      expect(captured).toHaveLength(1);
      expect(events.at(-1)?.outcome).toBe("skip-in-flight");

      // Past the cap the stranded entry is treated as abandoned: reclaimed.
      vi.setSystemTime(Date.now() + SHELL_CAPTURE_TASK_HARD_CAP_MS + 1_000);
      schedule();
      expect(captured).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("token guard: a stale task settling late cannot release its replacement's guard entry", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const key = "/wedge-token-guard:shell";
      const events: ShellCaptureDebugEvent[] = [];
      const captured: Array<() => Promise<void>> = [];
      const ctx = makeWedgedCtx();
      const reqCtx = makeScheduleReqCtx(captured);
      const descriptor = {
        key,
        buildVersion: "test-build",
        store: { putShell: vi.fn() } as any,
        debugSink: (e: ShellCaptureDebugEvent) => events.push(e),
      };
      const schedule = () =>
        scheduleShellCapture(
          ctx,
          new Request("http://localhost/wedge"),
          {},
          new URL("http://localhost/wedge"),
          reqCtx,
          validSsr(),
          descriptor,
        );

      schedule();
      expect(captured).toHaveLength(1);
      const taskA = captured[0]!();
      await vi.advanceTimersByTimeAsync(0); // reach the wedged match; cap armed

      // Clock (but not the timer queue) passes the cap: entry A reads as
      // stranded and a replacement is admitted with its own token.
      const wallStart = Date.now();
      vi.setSystemTime(wallStart + SHELL_CAPTURE_TASK_HARD_CAP_MS + 1_000);
      schedule();
      expect(captured).toHaveLength(2);

      // Now drain the timer queue so task A's overdue cap fires and A settles
      // LATE. Its release runs with token A while the guard holds token B.
      await vi.advanceTimersByTimeAsync(SHELL_CAPTURE_TASK_HARD_CAP_MS + 1);
      await taskA;

      // Draining also advanced the wall clock past B's freshness; rewind so
      // B's entry reads fresh again — the next schedule then tells apart
      // "B's entry survived" (skip-in-flight) from "A's late release evicted
      // it" (admitted).
      vi.setSystemTime(Date.now() - (SHELL_CAPTURE_TASK_HARD_CAP_MS + 1));
      clearCaptureBackoff(key); // A's error backed the key off; isolate the guard
      schedule();
      expect(captured).toHaveLength(2); // still guarded by the replacement
      expect(events.at(-1)?.outcome).toBe("skip-in-flight");
    } finally {
      vi.useRealTimers();
      errSpy.mockRestore();
    }
  });
});
