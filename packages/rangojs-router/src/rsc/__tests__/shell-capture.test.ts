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
  capShellWindow,
  lastStoredCaptureSeq,
  REFUSED_CAPTURE_DEV_MAX_MS,
  type ShellCaptureDebugEvent,
} from "../shell-capture.js";
import { SHELL_CAPTURE_TASK_HARD_CAP_MS } from "../shell-capture-constants.js";
import {
  RecordingShellStore,
  estimateShellEntryBytes,
} from "../../cache/shell-snapshot.js";
import type { CachedEntryData, ShellCacheEntry } from "../../cache/types.js";
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
import {
  SHELL_BAKE_TAG_OWNER,
  armRecordTagOwners,
  cacheTag,
  linkLoaderTagsTo,
  recordLoaderTags,
  recordRequestTags,
} from "../../cache/cache-tag.js";
import { runInsideLoaderScope } from "../../server/context.js";
import type { HandlerContext } from "../handler-context.js";
import type { SSRModule } from "../types.js";

// The drain lazily imports the Flight codec only for SETTLED bake-lane
// containers; the real module pulls the virtual @vitejs/plugin-rsc import that
// unit configs cannot resolve, so pin it to JSON here (shape-faithful for the
// hole-bit assertions below).
vi.mock("../../cache/segment-codec.js", () => ({
  serializeResult: vi.fn(async (value: unknown) => JSON.stringify(value)),
  deserializeResult: vi.fn(async (value: string) => JSON.parse(value)),
  // The record-first step renders the capture from the doc record's
  // fragments (shell-capture.ts settleCaptureRecord).
  fragmentSegments: vi.fn(async (data: any[]) =>
    data.map((item) => ({
      ...item.metadata,
      component: { __rangoFragment: 1, f: item.encoded },
    })),
  ),
}));

/** The doc record key the harness contexts use. */
const DOC_KEY = "doc:localhost/p";

/**
 * A minimal doc record: what the match pipeline's doc scope writes during a
 * real capture (cache-scope.ts cacheRoute). Every document entry a HIT can
 * serve carries one; a capture without it is refused.
 */
function docRecord(tags?: string[]): CachedEntryData {
  return {
    segments: [
      {
        encoded: "0:null",
        metadata: { id: "M0L0", type: "layout" },
      } as CachedEntryData["segments"][number],
    ],
    handles: "",
    expiresAt: Date.now() + 300_000,
    ...(tags ? { tags } : {}),
  };
}

/** Record the doc record into a capture's recording store, as the pipeline does. */
function withDocRecord<
  T extends { recordSegmentWrite(k: string, d: CachedEntryData): void },
>(recording: T, docKey: string = DOC_KEY, tags?: string[]): T {
  recording.recordSegmentWrite(docKey, docRecord(tags));
  return recording;
}

/** The tags a stubbed capture's doc record collected, and when it lands. */
interface DocRecordTags {
  tags: string[];
  /** Written by a tracked write after an await, as cacheRoute's is. */
  late?: boolean;
  /** Runs inside the capture's match, before the record is written. */
  during?: () => void;
}

/**
 * Inside a stubbed capture match: write the doc record into the ambient
 * capture context, as withCacheStore's cacheRoute does for a real match.
 * `record.tags` stands for what the record's serialization collected
 * (cache-scope.ts collectRecordTags).
 */
function writeDocRecord(
  docKey: string = DOC_KEY,
  record?: DocRecordTags,
): void {
  const ctx = getRequestContext();
  const recording = ctx._cacheStore;
  if (!(recording instanceof RecordingShellStore)) return;
  if (ctx._shellImplicitCache) ctx._shellImplicitCache.docKey = docKey;
  if (record?.late) {
    ctx.waitUntil(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      withDocRecord(recording, docKey, record.tags);
    });
    return;
  }
  withDocRecord(recording, docKey, record?.tags);
}

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

describe("capShellWindow (a shell never outlives its route cache() record)", () => {
  const now = 1_000_000;
  /** A record fresh for `fresh` ms more, then stale for `stale` ms. */
  const record = (fresh: number, stale: number) => ({
    freshUntil: now + fresh,
    staleUntil: now + fresh + stale,
    ttl: 60,
    swr: 30,
  });

  it("caps freshness to the record's and the total lifetime to the record's", () => {
    // ttl 300 -> 60 (the record's fresh end); ttl+swr 420 -> 90.
    expect(capShellWindow(300, 120, record(60_000, 30_000), now)).toEqual({
      ttl: 60,
      swr: 30,
    });
    // A shorter ppr window is kept.
    expect(capShellWindow(10, 5, record(60_000, 30_000), now)).toEqual({
      ttl: 10,
      swr: 5,
    });
    // The record's stale time can extend a shell whose ppr swr is 0: the
    // total lifetime is capped, not raised past ppr's ttl + swr.
    expect(capShellWindow(300, 0, record(60_000, 30_000), now)).toEqual({
      ttl: 60,
      swr: 30,
    });
    expect(capShellWindow(60, 0, record(60_000, 30_000), now)).toEqual({
      ttl: 60,
      swr: 0,
    });
  });

  it("a record inside its swr window yields a shell stale from the start", () => {
    // cache({ ttl: 0, swr: 60 }) written just now.
    expect(capShellWindow(300, 0, record(0, 60_000), now)).toEqual({
      ttl: 0,
      swr: 60,
    });
    // Replayed 10 s past its fresh end.
    expect(capShellWindow(300, 0, record(-10_000, 60_000), now)).toEqual({
      ttl: 0,
      swr: 50,
    });
  });

  it("rounds up to whole seconds, at least 1 in all: a 1 s record captured 50 ms in", () => {
    expect(capShellWindow(300, 0, record(950, 0), now)).toEqual({
      ttl: 1,
      swr: 0,
    });
    expect(capShellWindow(300, 0, record(-500, 600), now)).toEqual({
      ttl: 0,
      swr: 1,
    });
    expect(capShellWindow(300, 0, record(29_300, 30_000), now)).toEqual({
      ttl: 30,
      swr: 30,
    });
  });

  it("counts a replayed record's age: a record written 50 s ago leaves 10 s", () => {
    expect(capShellWindow(60, 60, record(10_000, 0), now)).toEqual({
      ttl: 10,
      swr: 0,
    });
  });

  it("returns null once the record's total lifetime has run out", () => {
    expect(capShellWindow(300, 60, record(-1_000, 0), now)).toBeNull();
    expect(capShellWindow(300, 60, record(0, 0), now)).toBeNull();
    expect(capShellWindow(300, 60, record(-61_000, 60_000), now)).toBeNull();
  });
});

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
      _cacheStore: withDocRecord(
        new RecordingShellStore((putShell ? { putShell } : {}) as any),
      ),
      _shellImplicitCache: { docKey: DOC_KEY },
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

  it("refuses a capture whose marker names a doc record the snapshot lacks", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const putShell = makePutShell();
      const reqCtx = makeReqCtx(putShell);
      // A stale marker docKey without its record: a HIT could not replay it.
      reqCtx._cacheStore = new RecordingShellStore({ putShell } as any);
      reqCtx._shellImplicitCache = { docKey: "doc:host/p" };

      const outcome = await captureAndStoreShell(
        makeShellSsrModule(),
        emptyStream(),
        createHandleStore(),
        reqCtx,
        { key: "/doc-key-empty:shell", buildVersion: "test-build", ttl: 300 },
      );

      expect(outcome).toBe("refused");
      expect(putShell).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses and reports a shell invalidated by its own capture render", async () => {
    const store = new MemorySegmentCacheStore();
    const reqCtx = makeReqCtx();
    reqCtx._cacheStore = withDocRecord(new RecordingShellStore(store));
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

  it("refuses (backs off) a shell the store declares uncacheable — not a per-MISS recapture loop", async () => {
    // The CFCacheStore KV-less purge-mode shape: an over-limit tag set can
    // NEVER store, and every retry would refuse identically — the ack must
    // route into the refused-capture backoff, not read as "stored". Stubbed
    // (not MemorySegmentCacheStore) because only CFCacheStore returns it.
    const putShell = vi.fn(
      async (): Promise<"stored" | "invalidated" | "uncacheable" | void> =>
        "uncacheable",
    );
    const reqCtx = makeReqCtx();
    reqCtx._cacheStore = withDocRecord(
      new RecordingShellStore({ putShell } as any),
    );
    const stats: Pick<ShellCaptureDebugEvent, "storeWrite"> = {};
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const outcome = await captureAndStoreShell(
      makeShellSsrModule(),
      emptyStream(),
      createHandleStore(),
      reqCtx,
      {
        key: "/uncacheable-tags:shell",
        buildVersion: "test-build",
        ttl: 300,
        tags: ["t"],
      },
      stats,
      Date.now(),
    );

    expect(outcome).toBe("refused");
    expect(stats.storeWrite).toBe("uncacheable");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("cannot cache this shell"),
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
      reqCtx._shellCaptureGuardTripped = {
        surface: "cookies()",
        fix: "Read it in a live loader.",
      };

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
      // The warning names the read and gives the fix the guard recorded.
      expect(warnings[0][0]).toContain(
        "handler/render code (no loader body was executing) read cookies() during capture",
      );
      expect(warnings[0][0]).toContain("refused");
      expect(warnings[0][0]).toContain("Read it in a live loader.");
      expect(warnings[0][0]).toContain("The loader lane rule");
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
      const loaderError = new Error("loader boom");
      const rejected = Promise.reject(loaderError);
      rejected.catch(() => {});
      reqCtx._shellCaptureLoaderRecords = new Map([["M0D0.app/x#L", rejected]]);
      // A render error recorded alongside does not preempt this refusal (#915).
      reqCtx._renderErrors = [loaderError];

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

  it("refuses when a bake-lane loader settled with redirect()/notFound() during capture", async () => {
    // Signals RESOLVE as ok:false envelopes, so the rejection check never sees
    // them; the tree builder turns them into LoaderRedirect / not-found UI,
    // which must not bake into a shell every visitor shares.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const putShell = makePutShell();
      const reqCtx = makeReqCtx(putShell);
      reqCtx._shellCaptureLoaderRecords = new Map([
        [
          "M0D0.app/x#L",
          Promise.resolve({
            __loaderResult: true,
            ok: false,
            redirect: { to: "/login" },
            error: { message: "Loader redirected to /login", name: "Error" },
            fallback: null,
          }),
        ],
      ]);

      const outcome = await captureAndStoreShell(
        makeShellSsrModule(),
        emptyStream(),
        createHandleStore(),
        reqCtx,
        { key: "/bake-signal:shell", buildVersion: "test-build", ttl: 300 },
      );

      expect(outcome).toBe("refused");
      expect(putShell).not.toHaveBeenCalled();
      const warnings = warnSpy.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].includes("/bake-signal:shell"),
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0][0]).toContain("settled with redirect()/notFound()");
    } finally {
      warnSpy.mockRestore();
    }
  });

  // The hole bit rides each pinned loader record (ShellSnapshotLoaderValue):
  // holes: 0 = fully pinned, the HIT overlay resolves pin-first without
  // gating on the fresh run; holes: 1 = hole markers present, the overlay
  // must wait for the fresh run's live promises. Computed once at capture
  // (elide already walks every node) so the per-HIT path never rescans.
  it("pins settled bake-lane containers with the capture-computed hole bit and an explicit runs bit", async () => {
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
      snapshot?: {
        family: string;
        key: string;
        value: { holes?: 0 | 1; runs?: 0 | 1 };
      }[];
    };
    const byKey = new Map(
      (entry.snapshot ?? [])
        .filter((r) => r.family === "loader")
        .map((r) => [r.key, r.value]),
    );
    expect(byKey.get("R0D0.app/x#Full")?.holes).toBe(0);
    expect(byKey.get("R0D1.app/x#Holey")?.holes).toBe(1);
    // Written as 0, not omitted: an absent bit marks a record written before
    // the bit, which a HIT runs.
    expect(byKey.get("R0D0.app/x#Full")?.runs).toBe(0);
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
  it("drops over-cap loader pins, stores the shell with its doc record, and reports once per key", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const putShell = makePutShell();
      const runOnce = async () => {
        // Fresh recording store per capture (mirrors the per-capture derived
        // context); one recorded item-family value well over the 1 KiB cap.
        const recording = withDocRecord(
          new RecordingShellStore(new MemorySegmentCacheStore()),
        );
        // A loader pin (only loader-read records survive pruning).
        await runInsideLoaderScope(() =>
          recording.setItem("big-key", "x".repeat(4096)),
        );
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

      // First capture: pins over cap → dropped, shell stored with its doc
      // record.
      expect(await runOnce()).toBe("stored");
      // Recapture (TTL roll): still stores, still drops, does NOT re-warn.
      expect(await runOnce()).toBe("stored");

      expect(putShell).toHaveBeenCalledTimes(2);
      for (const call of putShell.mock.calls) {
        const entry = call[1] as ShellCacheEntry;
        expect(entry.snapshot?.map((r) => `${r.family} ${r.key}`)).toEqual([
          `segment ${DOC_KEY}`,
        ]);
        expect(entry.docKey).toBe(DOC_KEY);
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
    const recording = withDocRecord(
      new RecordingShellStore(new MemorySegmentCacheStore()),
    );
    await runInsideLoaderScope(() => recording.setItem("small-key", "hello"));
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
      // Remedy ladder is present: cache() / a live loader / a nested
      // promise or drop ssr: false, plus the shared lane hint (loading() or an
      // inline <Suspense>).
      expect(String(bakeWarnings[0]![0])).toContain("live loader");
      expect(String(bakeWarnings[0]![0])).toContain("cache()");
      expect(String(bakeWarnings[0]![0])).toContain("drop ssr: false");
      expect(String(bakeWarnings[0]![0])).toContain("loading()");
      expect(String(bakeWarnings[0]![0])).toContain("The loader lane rule");

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

  it("stores the no-cookie default as entry.initialTheme, not the capturing visitor's theme (#971)", async () => {
    const putShell = makePutShell();
    const ssrModule = {
      renderHTML: vi.fn(),
      captureShellHTML: vi.fn(async () => ({
        prelude: enc("<html><body>shell</body></html>"),
        postponed: null,
      })),
    } as unknown as SSRModule;
    const reqCtx = makeReqCtx();
    // The derived capture context: buildFullPayload rendered with the default
    // (payloadInitialTheme), so the serve tail must replay the same value
    // (ShellCacheEntry.initialTheme). The capturing visitor's cookie is dark.
    reqCtx._shellCaptureRun = true;
    reqCtx._themeConfig = { defaultTheme: "light" };
    reqCtx._readTheme = () => "dark";

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

  // Issue #915: a component that throws inside a Suspense boundary does not
  // reject the prerender. Fizz reports it through onError and the prelude
  // carries the errored boundary; storing it would serve that on every HIT.
  it("does not store a shell whose prerender reported a component error; rethrows it (#915)", async () => {
    const store = new MemorySegmentCacheStore();
    const key = "/fizz-error:shell";
    const shellError = new Error("shell widget threw");
    const erroredModule = {
      renderHTML: vi.fn(),
      captureShellHTML: vi.fn(
        async (
          _stream: ReadableStream<Uint8Array>,
          opts: { onError?: (error: unknown) => void },
        ) => {
          opts.onError?.(shellError);
          return {
            prelude: enc(
              "<html><body>shell<!--$!--><template></template><!--/$--></body></html>",
            ),
            postponed: null,
          };
        },
      ),
    } as unknown as SSRModule;
    const reqCtx = makeReqCtx();
    reqCtx._cacheStore = withDocRecord(new RecordingShellStore(store));
    reqCtx._renderErrors = [];

    await expect(
      captureAndStoreShell(
        erroredModule,
        emptyStream(),
        createHandleStore(),
        reqCtx,
        { key, buildVersion: "test-build", ttl: 300 },
      ),
    ).rejects.toBe(shellError);
    expect(await store.getShell(key)).toBeNull();

    // A later clean capture of the same key stores normally.
    const cleanCtx = makeReqCtx();
    cleanCtx._cacheStore = withDocRecord(new RecordingShellStore(store));
    cleanCtx._renderErrors = [];
    expect(
      await captureAndStoreShell(
        makeShellSsrModule(),
        emptyStream(),
        createHandleStore(),
        cleanCtx,
        { key, buildVersion: "test-build", ttl: 300 },
      ),
    ).toBe("stored");
    expect(await store.getShell(key)).not.toBeNull();
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

// Snapshot pruning (issue #941, docs/design/shell-entry-layout.md §2): a
// capture stores only the records a reader of its entry consumes. Each keep
// test flips exactly one condition of the prune rule.
describe("captureAndStoreShell: snapshot pruning", () => {
  const DOC_KEY = "doc:host/p";

  interface PruneSetup {
    reqCtx: any;
    recording: RecordingShellStore;
  }

  /**
   * A capture whose recording saw what a covered document capture sees: the
   * implicit doc record, a handler-read item, a loader-read item, a response
   * and a bake-lane loader container. `adjust` flips one condition.
   */
  async function capturePrunable(
    adjust?: (setup: PruneSetup) => void | Promise<void>,
    options: {
      inner?: MemorySegmentCacheStore;
      descriptor?: Partial<Parameters<typeof captureAndStoreShell>[4]>;
      expectRefused?: boolean;
      /** The descriptor store's value limit (SegmentCacheStore.maxShellEntryBytes). */
      maxShellEntryBytes?: number;
    } = {},
  ): Promise<ShellCacheEntry> {
    const inner = options.inner ?? new MemorySegmentCacheStore();
    await inner.setItem("use-cache:loader", "L", { ttl: 60 });
    const putShell = makePutShell();
    const recording = new RecordingShellStore(inner);
    recording.recordSegmentWrite(DOC_KEY, {
      segments: [{ encoded: "", metadata: { id: "R0" } } as any],
      handles: "",
      expiresAt: Date.now() + 60_000,
    });
    await recording.setItem("use-cache:handler", "H", { ttl: 60 });
    await runInsideLoaderScope(() => recording.getItem("use-cache:loader"));
    await recording.putResponse("resp:handler", new Response("R"), 60);
    const reqCtx: any = {
      _cacheStore: recording,
      _reportBackgroundError: vi.fn(),
      _requestTags: new Set<string>(),
      _shellImplicitCache: { docKey: DOC_KEY },
      _shellCaptureLoaderRecords: new Map([
        ["M0L0D0.bake", Promise.resolve({ baked: 1 })],
      ]),
    };
    await adjust?.({ reqCtx, recording });
    const outcome = await captureAndStoreShell(
      {
        renderHTML: vi.fn(),
        captureShellHTML: vi.fn(async () => ({
          prelude: enc("<html><body>shell</body></html>"),
          postponed: null,
        })),
      } as unknown as SSRModule,
      emptyStream(),
      createHandleStore(),
      reqCtx,
      {
        key: "/p:shell",
        buildVersion: "test-build",
        ttl: 300,
        store: {
          putShell,
          maxShellEntryBytes: options.maxShellEntryBytes,
        } as any,
        ...options.descriptor,
      },
    );
    if (options.expectRefused) {
      expect(outcome).toBe("refused");
      expect(putShell).not.toHaveBeenCalled();
      return undefined as unknown as ShellCacheEntry;
    }
    expect(outcome).toBe("stored");
    return putShell.mock.calls[0]![1];
  }

  const records = (entry: ShellCacheEntry): string[] =>
    (entry.snapshot ?? []).map((r) => `${r.family} ${r.key}`);

  const EVERY_RECORD = [
    `segment ${DOC_KEY}`,
    "item use-cache:handler",
    "item use-cache:loader",
    "response resp:handler",
    "loader M0L0D0.bake",
  ];

  it("drops the item and response records only handler code read", async () => {
    const entry = await capturePrunable();
    expect(records(entry)).toEqual([
      `segment ${DOC_KEY}`,
      "item use-cache:loader",
      "loader M0L0D0.bake",
    ]);
    expect(entry.prunedRecords).toBe("item:1/response:1");
    expect(entry.docKey).toBe(DOC_KEY);
  });

  it("R2.4 keeps a record a loader only missed on (it joined the handler's write)", async () => {
    const entry = await capturePrunable(async ({ recording }) => {
      await runInsideLoaderScope(() => recording.getItem("use-cache:joined"));
      await recording.setItem("use-cache:joined", "J", { ttl: 60 });
    });
    expect(records(entry)).toContain("item use-cache:joined");
    expect(records(entry)).not.toContain("item use-cache:handler");
  });

  // A document capture that ran handlers must store its doc record: a HIT
  // replays the handler layer from it and never runs a handler.
  it.each([
    [
      "the capture recorded no doc record",
      (reqCtx: any) => {
        reqCtx._shellImplicitCache = {};
      },
    ],
    [
      "docKey names a record the snapshot lacks",
      (reqCtx: any) => {
        reqCtx._shellImplicitCache.docKey = "doc:host/other";
      },
    ],
  ])("refuses a document capture when %s", async (_label, adjust) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await capturePrunable(({ reqCtx }) => adjust(reqCtx), {
        expectRefused: true,
        descriptor: { key: `/no-doc-record-${_label.length}:shell` },
      });
      expect(
        warn.mock.calls.some((call) =>
          String(call[0]).includes("no doc segment record"),
        ),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  // Every HIT looks the record up by the entry's own docKey and never runs a
  // handler, so none of these conditions keeps a handler-read record.
  it.each([
    [
      "the store has a keyGenerator",
      undefined,
      new MemorySegmentCacheStore({
        keyGenerator: (_ctx, defaultKey) => defaultKey,
      }),
    ],
    [
      "the capture was build-time (its doc key carries the build host)",
      ({ reqCtx }: PruneSetup) => {
        reqCtx.build = true;
      },
      undefined,
    ],
  ] as const)(
    "prunes handler-read records when %s",
    async (_l, adjust, inner) => {
      const entry = await capturePrunable(adjust, { inner });
      expect(records(entry)).toEqual([
        `segment ${DOC_KEY}`,
        "item use-cache:loader",
        "loader M0L0D0.bake",
      ]);
    },
  );

  it("drops segment records other than the doc record (an explicit tier's)", async () => {
    const entry = await capturePrunable(({ recording }) => {
      recording.recordSegmentWrite("seg:explicit", {
        segments: [{ encoded: "", metadata: { id: "R0" } } as any],
        handles: "",
        expiresAt: Date.now() + 60_000,
      });
    });
    expect(records(entry)).not.toContain("segment seg:explicit");
    expect(entry.prunedRecords).toBe("item:1/response:1/segment:1");
  });

  it("R1 keeps only the doc record for a navigation-only entry", async () => {
    const entry = await capturePrunable(undefined, {
      descriptor: { navigationOnly: true },
    });
    expect(records(entry)).toEqual([`segment ${DOC_KEY}`]);
    expect(entry.prunedRecords).toBe("item:2/response:1/loader:1");
  });

  it("applies the size cap to the pruned snapshot", async () => {
    const entry = await capturePrunable(
      async ({ recording }) => {
        await recording.setItem("use-cache:big", "x".repeat(4096), {
          ttl: 60,
        });
      },
      { descriptor: { maxSnapshotBytes: 2048 } },
    );
    expect(records(entry)).toEqual([
      `segment ${DOC_KEY}`,
      "item use-cache:loader",
      "loader M0L0D0.bake",
    ]);
    expect(entry.prunedRecords).toBe("item:2/response:1");
  });

  it("keeps the doc record over the cap and drops the loader pins", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const entry = await capturePrunable(
        async ({ recording }) => {
          await runInsideLoaderScope(() =>
            recording.setItem("use-cache:big", "x".repeat(4096), { ttl: 60 }),
          );
        },
        { descriptor: { key: "/pins-over-cap:shell", maxSnapshotBytes: 2048 } },
      );
      expect(records(entry)).toEqual([`segment ${DOC_KEY}`]);
      expect(entry.docKey).toBe(DOC_KEY);
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses an entry over the store's value limit (the doc record is never dropped)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const storePut = makePutShell();
      await capturePrunable(undefined, {
        expectRefused: true,
        descriptor: {
          key: "/entry-over-limit:shell",
          store: { putShell: storePut, maxShellEntryBytes: 64 } as any,
        },
      });
      expect(storePut).not.toHaveBeenCalled();
      expect(
        warn.mock.calls.some((call) =>
          String(call[0]).includes("64-byte value limit"),
        ),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  // Near the limit the guard must count what the store writes (the head with
  // its escaped postponed state and fixed fields), not just the raw parts: a
  // limit the raw parts fit under but the stored value does not is refused.
  it("measures the entry as stored, head included: refused just over the limit, stored at it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const entry = await capturePrunable();
      const preludeBytes = "<html><body>shell</body></html>".length;
      const raw =
        preludeBytes +
        new TextEncoder().encode(JSON.stringify(entry.snapshot)).length;
      const stored = estimateShellEntryBytes({
        preludeBytes,
        postponed: null,
        snapshot: entry.snapshot,
        tags: undefined,
        docKey: entry.docKey,
        prunedRecords: entry.prunedRecords,
      });
      expect(stored).toBeGreaterThan(raw);

      await capturePrunable(undefined, {
        expectRefused: true,
        maxShellEntryBytes: stored - 1,
        descriptor: { key: "/entry-near-limit:shell" },
      });
      const atLimit = await capturePrunable(undefined, {
        maxShellEntryBytes: stored,
        descriptor: { key: "/entry-at-limit:shell" },
      });
      expect(atLimit.docKey).toBe(entry.docKey);
    } finally {
      warn.mockRestore();
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
    record?: DocRecordTags,
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
        match: vi.fn(async () => {
          record?.during?.();
          writeDocRecord(DOC_KEY, record);
          return match;
        }),
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
    // A capture needs a cache store: its recording wrapper is where the doc
    // record lands.
    (reqCtx as any)._cacheStore = putShell
      ? { putShell }
      : new MemorySegmentCacheStore();
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

  it("an attempt whose route cache() record ran out reports expired, and the mirror keeps it", async () => {
    const events: ShellCaptureDebugEvent[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const putShell = makePutShell();
      // Each attempt's match reads a route record already past its end.
      const { ctx, ssrModule } = makeCtx(
        okMatch,
        vi.fn(async () => ({
          prelude: enc("<html><body>captured</body></html>"),
          postponed: null,
        })),
        {
          tags: [],
          during: () => {
            getRequestContext()._routeRecordWindow = {
              freshUntil: Date.now() - 1,
              staleUntil: Date.now() - 1,
              ttl: 300,
              swr: 0,
              written: false,
            };
          },
        },
      );

      const outcome = await runShellCapture(
        ctx,
        new Request("http://localhost/p"),
        {},
        new URL("http://localhost/p"),
        makeReqCtx(),
        ssrModule,
        {
          key: "/debug-expired:shell",
          buildVersion: "test-build",
          ttl: 300,
          store: { putShell } as any,
          debugSink: (e) => events.push(e),
        },
      );

      expect(outcome).toBe("no-shell");
      expect(putShell).not.toHaveBeenCalled();
      expect(events.map((e) => [e.outcome, e.attempt])).toEqual([
        ["expired", 1],
        ["expired", 2],
      ]);
      expect(
        takeCaptureDebugEventForTiming("/debug-expired:shell")?.outcome,
      ).toBe("expired");
    } finally {
      warnSpy.mockRestore();
    }
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

  // Issue #941: the no-shell warning listed causes but not which component
  // pinned the root. React reports each task still pending at the capture's
  // abort with its component stack; dev prints them once per key.
  it("names the components still pending at the abort in the dev no-shell warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const capture = vi.fn(
        async (
          _stream: ReadableStream<Uint8Array>,
          opts: {
            onAbortedTask?: (
              errorInfo: { componentStack?: string } | undefined,
            ) => void;
          },
        ) => {
          const componentStack =
            "\n    at PageBody\n    at SiteProvider\n    at Layout";
          opts.onAbortedTask?.({ componentStack });
          opts.onAbortedTask?.({ componentStack });
          opts.onAbortedTask?.(undefined);
          return null;
        },
      );
      const { ctx, ssrModule } = makeCtx(okMatch, capture as any);

      const outcome = await runShellCapture(
        ctx,
        new Request("http://localhost/p"),
        {},
        new URL("http://localhost/p"),
        makeReqCtx(),
        ssrModule,
        { key: "/pending-stacks:shell", buildVersion: "test-build", ttl: 300 },
        0,
      );

      expect(outcome).toBe("no-shell");
      const warning = warnSpy.mock.calls
        .map(([message]) => String(message))
        .find((message) => message.includes('"/pending-stacks:shell"'));
      expect(warning).toContain("Something suspends above <body>");
      expect(warning).toContain(
        "Components still pending when the capture froze the shell",
      );
      expect(warning).toContain("    at PageBody\n    at SiteProvider");
      expect(warning!.match(/at PageBody/g)).toHaveLength(1);
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

  // A MISS schedules after rendering; a capture that stored the key since the
  // MISS read it makes this one redundant.
  it("skips a MISS capture when a capture stored the key after the MISS read it (skip-stored)", async () => {
    const captured: Array<() => Promise<void>> = [];
    const events: ShellCaptureDebugEvent[] = [];
    const { ctx, ssrModule } = makeCtx(
      okMatch,
      vi.fn(async () => ({
        prelude: enc("<html><body>captured</body></html>"),
        postponed: null,
      })),
    );
    const reqCtx = makeReqCtx();
    (reqCtx as any).waitUntil = (task: () => Promise<void>) => {
      captured.push(task);
    };
    const key = "/skip-stored:shell";
    const descriptor = {
      key,
      buildVersion: "test-build",
      store: { putShell: makePutShell() } as any,
      debugSink: (e: ShellCaptureDebugEvent) => events.push(e),
    };
    const request = new Request("http://localhost/p");
    const url = new URL("http://localhost/p");
    const readBeforeStore = lastStoredCaptureSeq(key);

    scheduleShellCapture(ctx, request, {}, url, reqCtx, ssrModule, descriptor);
    await captured[0]!();
    expect(events.at(-1)?.outcome).toBe("stored");

    scheduleShellCapture(ctx, request, {}, url, reqCtx, ssrModule, {
      ...descriptor,
      storedSeqAtRead: readBeforeStore,
    });
    expect(captured).toHaveLength(1);
    expect(events.at(-1)?.outcome).toBe("skip-stored");

    // A MISS that read after that store still captures.
    scheduleShellCapture(ctx, request, {}, url, reqCtx, ssrModule, {
      ...descriptor,
      storedSeqAtRead: lastStoredCaptureSeq(key),
    });
    expect(captured).toHaveLength(2);
  });

  // Issue #915: a shell component that throws in the capture's Flight render
  // does not reject it (Flight reports through onError and completes with an
  // error row), so the prerender resolves with a prelude.
  it("does not store a shell whose capture Flight render reported an error; reports it and backs off (#915)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const store = new MemorySegmentCacheStore();
      const key = "/flight-error:shell";
      const shellError = new Error("reviews upstream down");
      let failFlight = true;
      const captureShellHTML = vi.fn(async () => ({
        prelude: enc("<html><body>shell</body></html>"),
        postponed: null,
      }));
      const { ctx, ssrModule } = makeCtx(okMatch, captureShellHTML as any);
      vi.mocked(ctx.renderToReadableStream).mockImplementation(((
        _payload: unknown,
        options?: { onError?: (error: unknown) => void },
      ) => {
        if (failFlight) options?.onError?.(shellError);
        return emptyStream();
      }) as any);
      const captured: Array<() => Promise<void>> = [];
      const reqCtx = makeReqCtx();
      (reqCtx as any).waitUntil = (task: () => Promise<void>) => {
        captured.push(task);
      };
      const request = new Request("http://localhost/flight-error");
      const url = new URL("http://localhost/flight-error");
      const descriptor = {
        key,
        buildVersion: "test-build",
        ttl: 300,
        store,
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

      expect(await store.getShell(key)).toBeNull();
      expect(captureShellHTML).toHaveBeenCalledTimes(1); // no retry
      expect(reqCtx._reportBackgroundError).toHaveBeenCalledWith(
        shellError,
        "cache-write",
      );
      // The capture's error stays on its own derived context.
      expect(reqCtx._renderErrors).toEqual([]);
      expect(isCaptureBackedOff(key)).toBe(true);

      // A later clean capture stores normally.
      clearCaptureBackoff(key);
      failFlight = false;
      scheduleShellCapture(
        ctx,
        request,
        {},
        url,
        reqCtx,
        ssrModule,
        descriptor,
      );
      await captured[1]!();
      expect(await store.getShell(key)).not.toBeNull();
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
      // The message names BOTH causes with the distinguishing signal, the
      // boundary-ownership rule, and the shared lane hint.
      expect(keyWarnings[0][0]).toContain("Suspense boundary");
      expect(keyWarnings[0][0]).toContain("owns the data");
      expect(keyWarnings[0][0]).toContain("a live loader (no ssr: false)");
      expect(keyWarnings[0][0]).toContain("The loader lane rule");
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
  // The shell's tags are its doc record's (what the record's serialization
  // collected: cache-scope.ts collectRecordTags) plus the route's ppr.tags,
  // and the bake-lane loaders'. The record is where the handler layer's
  // server components render, so a fresh capture and one that replayed the
  // route's cache() record store the same set.
  it("unions option tags (descriptor.tags) with the doc record's tags into putShell", async () => {
    const putShell = makePutShell();
    const { ctx, ssrModule } = makeCtx(
      okMatch,
      vi.fn(async () => ({ prelude: enc("<body>x</body>"), postponed: null })),
      { tags: ["collected:y"] },
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
        tags: ["op:x"],
      },
      0,
    );

    expect(putShell).toHaveBeenCalledTimes(1);
    const tags = putShell.mock.calls[0]![4];
    expect(new Set(tags)).toEqual(new Set(["op:x", "collected:y"]));
  });

  // #648: a render-called cacheTag() in the shell tree tags the doc record
  // (its serialization renders the component), and the record's tags tag the
  // shell. A tag recorded on the request outside the record — a hole's, or
  // the capture's own Flight render, which only splices the record's bytes —
  // does not.
  it("takes the shell tags from the doc record, not from tags recorded on the request outside it (#648)", async () => {
    const putShell = makePutShell();
    const { ctx, ssrModule } = makeCtx(
      okMatch,
      vi.fn(async () => ({ prelude: enc("<body>x</body>"), postponed: null })),
      { tags: ["baked-shell"] },
    );
    (ctx as any).renderToReadableStream = vi.fn(() => {
      cacheTag("outside-record");
      recordRequestTags(["hole-tag"]);
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
    expect(tags).toEqual(new Set(["ppr:static", "baked-shell"]));
  });

  // A bake-lane loader's data is in the shell though no handler reads it:
  // loader-cache.ts links it to SHELL_BAKE_TAG_OWNER, and its tags join the
  // record's.
  it("adds the tags of the bake-lane loaders the capture ran", async () => {
    const putShell = makePutShell();
    const { ctx, ssrModule } = makeCtx(
      okMatch,
      vi.fn(async () => ({ prelude: enc("<body>x</body>"), postponed: null })),
      {
        tags: ["record-tag"],
        // Inside the capture's match: match-api.ts arms the tag owners, and
        // loader-cache.ts links a bake-lane loader whose body tagged its data.
        during: () => {
          armRecordTagOwners();
          linkLoaderTagsTo(SHELL_BAKE_TAG_OWNER, "BakeLoader");
          recordLoaderTags("BakeLoader", ["bake-loader-tag"]);
        },
      },
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
      0,
    );

    expect(putShell).toHaveBeenCalledTimes(1);
    const tags = new Set(putShell.mock.calls[0]![4]);
    expect(tags).toEqual(new Set(["record-tag", "bake-loader-tag"]));
  });

  // #648: a tag present BOTH as a static ppr.tags entry (descriptor.tags) AND
  // on the doc record collapses to ONE stored tag (Set union), never a
  // duplicate on the entry.
  it("dedupes a tag present both statically and on the doc record into a single stored tag (#648)", async () => {
    const putShell = makePutShell();
    const { ctx, ssrModule } = makeCtx(
      okMatch,
      vi.fn(async () => ({ prelude: enc("<body>x</body>"), postponed: null })),
      { tags: ["dup"] },
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
        tags: ["dup"],
      },
      0,
    );

    expect(putShell.mock.calls[0]![4]).toEqual(["dup"]);
  });

  // #648 full round-trip: a tag on the captured shell's doc record makes the
  // entry evictable through the store's tag invalidation.
  it("a doc record tag makes the captured shell evictable via the store (#648)", async () => {
    const store = new MemorySegmentCacheStore();
    const { ctx, ssrModule } = makeCtx(
      okMatch,
      vi.fn(async () => ({
        prelude: enc("<html><body>x</body></html>"),
        postponed: null,
      })),
      { tags: ["evictable-shell"] },
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
      { key: "/p:shell", buildVersion: "test-build", ttl: 300, store },
      0,
    );

    // Captured and reachable.
    expect(await store.getShell("/p:shell")).not.toBeNull();
    // The record's tag drops it.
    await store.invalidateTags(["evictable-shell"]);
    expect(await store.getShell("/p:shell")).toBeNull();
  });

  // #676: a tag recorded AFTER an await inside an async shell server
  // component reaches the doc record when the record's write settles (the
  // record's serialization awaits the component). The capture reads the
  // record's tags only after its tracked writes settled, so the late tag is
  // on the stored shell.
  it("collects the tags of a doc record written after an await (#676)", async () => {
    const putShell = makePutShell();
    const { ctx, ssrModule } = makeCtx(
      okMatch,
      vi.fn(async () => ({ prelude: enc("<body>x</body>"), postponed: null })),
      { tags: ["async-shell-tag"], late: true },
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
        tags: ["ppr:static"],
      },
      0,
    );

    expect(putShell).toHaveBeenCalledTimes(1);
    const tags = new Set(putShell.mock.calls[0]![4]);
    expect(tags).toEqual(new Set(["ppr:static", "async-shell-tag"]));
  });

  // Capture data snapshot: a cache read-HIT the capture render performs through
  // the ambient (recording) store is recorded onto entry.snapshot, so a HIT can
  // replay it and match the frozen prelude. See cache/shell-snapshot.ts.
  it("records a loader's cache read-HIT performed during the capture render into entry.snapshot", async () => {
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
      // A bake-lane loader's read: the records only handler code read are
      // pruned (a HIT never runs a handler).
      readDone = runInsideLoaderScope(() =>
        getRequestContext()._cacheStore!.getItem!("use-cache:x"),
      );
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

  it("stores only the doc record when the capture render touches no other cache record", async () => {
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
    const entry = putShell.mock.calls[0]![1];
    expect(entry.snapshot?.map((r) => `${r.family} ${r.key}`)).toEqual([
      `segment ${DOC_KEY}`,
    ]);
    expect(entry.docKey).toBe(DOC_KEY);
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

// Wedge containment (production pilot incident): a capture whose render never
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

  it("a match wedged past ppr.captureTimeout ends the capture at the deadline, with no in-place retry", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const key = "/wedge-deadline:shell";
      const captured: Array<() => Promise<void>> = [];
      const ctx = makeWedgedCtx();
      const reqCtx = makeScheduleReqCtx(captured);
      scheduleShellCapture(
        ctx,
        new Request("http://localhost/wedge"),
        {},
        new URL("http://localhost/wedge"),
        reqCtx,
        validSsr(),
        {
          key,
          buildVersion: "test-build",
          store: { putShell: vi.fn() } as any,
          captureTimeout: 1_000,
        },
      );
      const task = captured[0]!();
      await vi.advanceTimersByTimeAsync(1_001);
      await task;
      expect(isCaptureBackedOff(key)).toBe(true);
      // Past the 400 ms retry delay too: attempt 1 ran out of its budget, so
      // no second match starts beside the one still running.
      await vi.advanceTimersByTimeAsync(500);

      expect(ctx.router.match).toHaveBeenCalledTimes(1);
      expect(reqCtx._reportBackgroundError).not.toHaveBeenCalled();
      const warning = warnSpy.mock.calls
        .map(([message]) => String(message))
        .find((message) => message.includes(`"${key}"`));
      expect(warning).toContain("did not return within ppr.captureTimeout");
      expect(warning).not.toContain("after an in-place retry");
      clearCaptureBackoff(key);
    } finally {
      vi.useRealTimers();
      warnSpy.mockRestore();
    }
  });

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
        // Past the hard cap, so the cap (not the match deadline) ends it:
        // the backstop for a wedge the capture's own deadlines miss.
        captureTimeout: SHELL_CAPTURE_TASK_HARD_CAP_MS * 2,
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
