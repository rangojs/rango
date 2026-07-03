import { describe, it, expect, vi } from "vitest";
import React from "react";
import {
  gateFlightForCapture,
  captureAndStoreShell,
  runShellCapture,
  scheduleShellCapture,
} from "../shell-capture.js";
import { createHandleStore } from "../../server/handle-store.js";
import {
  createRequestContext,
  type RequestContext,
} from "../../server/request-context.js";
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
    };
  }

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

  it("stores nothing when the sanity gate refuses (null result)", async () => {
    const putShell = makePutShell();
    const ssrModule = {
      renderHTML: vi.fn(),
      captureShellHTML: vi.fn(async () => null),
    } as unknown as SSRModule;

    await captureAndStoreShell(
      ssrModule,
      emptyStream(),
      createHandleStore(),
      makeReqCtx(putShell),
      { key: "/p:shell", store: { putShell } as any },
    );
    expect(putShell).not.toHaveBeenCalled();
  });

  // The eternal-MISS shape (a loader route without loading()) refuses on EVERY
  // request, so the diagnostic warning is deduped to once per key per isolate.
  // The e2e negative test can only observe the MISS header (the warning is a
  // worker-side console.warn); this pins the "at most once per key" contract and
  // the loading()-boundary guidance in the message.
  it("warns at most once per key on repeated refused (null) captures", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const putShell = makePutShell();
    const ssrModule = {
      renderHTML: vi.fn(),
      captureShellHTML: vi.fn(async () => null),
    } as unknown as SSRModule;
    // Unique key: warnedNullCaptures is module-level and persists across tests.
    const key = "/no-loading-once-per-key:shell";

    try {
      for (let i = 0; i < 3; i++) {
        await captureAndStoreShell(
          ssrModule,
          emptyStream(),
          createHandleStore(),
          makeReqCtx(putShell),
          { key, store: { putShell } as any },
        );
      }

      expect(putShell).not.toHaveBeenCalled();
      const keyWarnings = warnSpy.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].includes(key),
      );
      expect(keyWarnings).toHaveLength(1);
      expect(keyWarnings[0][0]).toContain("loading() boundary");
    } finally {
      warnSpy.mockRestore();
    }
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

  it("stores nothing when the capture sanity gate refuses (null)", async () => {
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
    );

    expect(ssrModule.captureShellHTML).toHaveBeenCalledTimes(1);
    expect(putShell).not.toHaveBeenCalled();
  });

  it("stampede guard: a second schedule for the same in-flight key is skipped, then allowed after it settles", async () => {
    const captured: Array<() => Promise<void>> = [];
    const { ctx, ssrModule } = makeCtx(
      okMatch,
      vi.fn(async () => null),
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
