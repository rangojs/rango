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
  REFUSED_CAPTURE_DEV_MAX_MS,
} from "../shell-capture.js";
import { createHandleStore } from "../../server/handle-store.js";
import {
  createRequestContext,
  getRequestContext,
  type RequestContext,
} from "../../server/request-context.js";
import { MemorySegmentCacheStore } from "../../cache/memory-segment-store.js";
import { cacheTag, recordRequestTags } from "../../cache/cache-tag.js";
import type { HandlerContext } from "../handler-context.js";
import type { SSRModule } from "../types.js";

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
      _entry: {
        prelude: string;
        postponed: string | null;
        reactVersion: string;
        initialTheme?: string;
        createdAt: number;
      },
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
        { key: "/guard-trip:shell", ttl: 300 },
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
        { key: "/bake-reject:shell", ttl: 300 },
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
      { key: "/bake-pending:shell", ttl: 300 },
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
    expect(typeof entry.createdAt).toBe("number");
    expect(
      new TextDecoder().decode(new Uint8Array(base64ToBytes(entry.prelude))),
    ).toBe("<html><body>shell</body></html>");
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
      { key: "/p:shell", store: { putShell: flagPut } as any },
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
      { key: "/p:shell", store: { putShell } as any },
    );
    expect(outcome).toBe("no-shell");
    expect(putShell).not.toHaveBeenCalled();
  });

  it("returns 'no-shell' (retryable) when captureShellHTML rejects with an AbortError", async () => {
    // Defensive: captureShellHTML normally converts its own abort to a null return.
    // If an AbortError still escapes as a rejection, captureAndStoreShell classifies
    // it as the same retryable degradation — NOT a reported failure.
    const putShell = makePutShell();
    const abortErr = Object.assign(new Error("aborted"), {
      name: "AbortError",
    });
    const ssrModule = {
      renderHTML: vi.fn(),
      captureShellHTML: vi.fn(async () => {
        throw abortErr;
      }),
    } as unknown as SSRModule;
    const reqCtx = makeReqCtx(putShell);

    const outcome = await captureAndStoreShell(
      ssrModule,
      emptyStream(),
      createHandleStore(),
      reqCtx,
      { key: "/p:shell", store: { putShell } as any },
    );
    expect(outcome).toBe("no-shell");
    expect(putShell).not.toHaveBeenCalled();
    // An abort is expected degradation, not an error — nothing reported.
    expect(reqCtx._reportBackgroundError).not.toHaveBeenCalled();
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
        { key: "/p:shell", store: { putShell } as any },
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
        { key: "/p:shell", store: { putShell } as any },
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
      { key: "/p:shell", ttl: 300, store: { putShell } as any },
    );

    expect(ctx.router.match).toHaveBeenCalledTimes(1);
    expect(ssrModule.captureShellHTML).toHaveBeenCalledTimes(1);
    expect(putShell).toHaveBeenCalledTimes(1);
    expect(putShell.mock.calls[0]![0]).toBe("/p:shell");
    // The foreground store was untouched (the derived context isolates it).
    expect(reqCtx._handleStore).toBeDefined();
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
      { key: "/p:shell", store: { putShell } as any },
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
      { key: "/p:shell", store: { putShell } as any },
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
      { key: "/p:shell", ttl: 300, store: { putShell } as any },
      0,
    );

    expect(captureShellHTML).toHaveBeenCalledTimes(2);
    expect(putShell).toHaveBeenCalledTimes(1);
    expect(putShell.mock.calls[0]![0]).toBe("/p:shell");
  });

  // Deliverable 1(b): a first attempt that REJECTS with an AbortError is retryable.
  it("retries when the first attempt rejects with an AbortError, then stores", async () => {
    const putShell = makePutShell();
    const abortErr = Object.assign(new Error("aborted"), {
      name: "AbortError",
    });
    const captureShellHTML = vi
      .fn()
      .mockRejectedValueOnce(abortErr)
      .mockResolvedValueOnce({
        prelude: enc("<html><body>warm</body></html>"),
        postponed: null,
      });
    const { ctx, ssrModule } = makeCtx(okMatch, captureShellHTML as any);

    await runShellCapture(
      ctx,
      new Request("http://localhost/p"),
      {},
      new URL("http://localhost/p"),
      makeReqCtx(),
      ssrModule,
      { key: "/p:shell", store: { putShell } as any },
      0,
    );

    expect(captureShellHTML).toHaveBeenCalledTimes(2);
    expect(putShell).toHaveBeenCalledTimes(1);
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
        { key: "/p:shell", store: { putShell } as any },
        0,
      ),
    ).rejects.toThrow("shell component blew up");

    expect(captureShellHTML).toHaveBeenCalledTimes(1); // no retry
    expect(putShell).not.toHaveBeenCalled();
  });

  // scheduleShellCapture routes a propagated genuine error through
  // reportCacheError exactly once, does NOT retry, and (Deliverable 8) backs the
  // key off since a genuine failure recurs.
  it("reports a genuine capture error once via reportCacheError, then backs the key off", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const captured: Array<() => Promise<void>> = [];
      const captureShellHTML = vi.fn(async () => {
        throw new Error("boom");
      });
      const { ctx, ssrModule } = makeCtx(okMatch, captureShellHTML as any);
      const reqCtx = makeReqCtx();
      (reqCtx as any).waitUntil = (task: () => Promise<void>) => {
        captured.push(task);
      };
      const request = new Request("http://localhost/err");
      const url = new URL("http://localhost/err");
      const descriptor = {
        key: "/err-genuine:shell",
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

      // No retry on a non-abort error, reported exactly once.
      expect(captureShellHTML).toHaveBeenCalledTimes(1);
      expect(reqCtx._reportBackgroundError).toHaveBeenCalledTimes(1);

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
            { key, store: { putShell } as any },
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
        { key, store: { putShell } as any },
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
      { key: "/p:shell", store: { putShell } as any, tags: ["op:x"] },
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
      { key: "/p:shell", store: { putShell } as any, tags: ["ppr:static"] },
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
      { key: "/p:shell", store: { putShell } as any },
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
      { key: "/p:shell", store: { putShell } as any, tags: ["dup"] },
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
      { key: "/p:shell", ttl: 300, store },
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
      { key: "/p:shell", store: { putShell } as any, tags: ["ppr:static"] },
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
      { key: "/p:shell", store: { putShell } as any },
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
      { key: "/p:shell", ttl: 300, store },
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
      { key: "/p:shell", store },
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
      { key: "/p:shell", store: { putShell } as any },
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
        { key: "/p:shell", store: { putShell } as any },
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
      { key: "/p:shell", store: { putShell } as any },
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
