import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";

// Mock renderSegments so SsrRoot renders a controllable document tree (with a
// Suspense hole) without pulling in the full segment system. The mock is
// module-level so vitest hoists it above the imports below.
vi.mock("../../segment-system.js", () => ({
  renderSegments: vi.fn(),
}));

import { renderSegments } from "../../segment-system.js";
import {
  createSSRHandler,
  createShellCaptureHandler,
  createShellResumeHandler,
  type SSRDependencies,
} from "../index";

// Real React PPR + HTML-injection primitives. Node has Web Streams, so the
// edge builds run in the vitest node worker (no react-server condition needed;
// createFromReadableStream is faked below).
import { prerender } from "react-dom/static.edge";
import { resume } from "react-dom/server.edge";
import { renderToReadableStream } from "react-dom/server.edge";
import { injectRSCPayload } from "rsc-html-stream/server";

const mockedRenderSegments = vi.mocked(renderSegments);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * A document tree with a static shell and one Suspense hole. The hole suspends
 * on `dynamicPromise` — pass a never-resolving promise to model capture, a
 * resolved promise to model resume. `label` distinguishes capture vs resume
 * output so ordering can be asserted.
 */
function makeTree(dynamicPromise: Promise<unknown>, label: string) {
  function Dynamic() {
    React.use(dynamicPromise);
    return React.createElement("p", { id: "dyn" }, `DYNAMIC-${label}`);
  }
  return React.createElement(
    "html",
    null,
    React.createElement(
      "body",
      null,
      React.createElement("h1", null, "SHELL-CONTENT"),
      React.createElement(
        React.Suspense,
        { fallback: React.createElement("span", null, "FALLBACK-UI") },
        React.createElement(Dynamic),
      ),
    ),
  );
}

/** A tree that suspends at the root, before any `<html>`/`<body>` is emitted. */
function makeRootPostponeTree(dynamicPromise: Promise<unknown>) {
  function LateRoot() {
    React.use(dynamicPromise);
    return React.createElement(
      "html",
      null,
      React.createElement("body", null, "late-shell"),
    );
  }
  return React.createElement(
    React.Suspense,
    { fallback: null },
    React.createElement(LateRoot),
  );
}

/** A Flight-stream stand-in. Its bytes become the __FLIGHT_DATA__ push text. */
function makeRscStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

/** Drain a stream to a string, failing (not hanging) if it never closes. */
async function readAll(
  stream: ReadableStream<Uint8Array>,
  timeoutMs = 4000,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error("readAll timed out: stream never closed")),
      timeoutMs,
    );
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      if (value) chunks.push(value);
    }
  } finally {
    clearTimeout(timeoutId);
  }
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return decoder.decode(out);
}

const BOOTSTRAP_MARKER = "__BOOTSTRAP_MARKER__";

function makeDeps(overrides: Partial<SSRDependencies> = {}): SSRDependencies {
  return {
    createFromReadableStream: vi.fn().mockResolvedValue({
      metadata: { pathname: "/", params: {}, matched: ["/"], segments: [] },
    }),
    renderToReadableStream: renderToReadableStream as any,
    injectRSCPayload: injectRSCPayload as any,
    loadBootstrapScriptContent: vi.fn().mockResolvedValue(BOOTSTRAP_MARKER),
    prerender: prerender as any,
    resume: resume as any,
    ...overrides,
  };
}

/** Run a capture over a shell whose hole never resolves. */
async function captureShell(
  deps: SSRDependencies,
  label: string,
  opts?: { quiesce?: Promise<void>; maxWaitMs?: number },
) {
  mockedRenderSegments.mockImplementation(() =>
    Promise.resolve(makeTree(new Promise(() => {}), label)),
  );
  const capture = createShellCaptureHandler(deps);
  return capture(makeRscStream("CAPTURE_FLIGHT"), {
    quiesce: opts?.quiesce ?? Promise.resolve(),
    maxWaitMs: opts?.maxWaitMs,
  });
}

afterEach(() => {
  mockedRenderSegments.mockReset();
});

describe("createShellCaptureHandler", () => {
  it("throws at creation when prerender dep is missing", () => {
    expect(() =>
      createShellCaptureHandler(makeDeps({ prerender: undefined })),
    ).toThrow(/prerender/);
  });

  it("(a) returns a prelude with shell + fallback + bootstrap, not the hole; postponed round-trips", async () => {
    const result = await captureShell(makeDeps(), "cap");
    expect(result).not.toBeNull();

    const preludeText = decoder.decode(result!.prelude);
    expect(preludeText).toContain("<body");
    expect(preludeText).toContain("SHELL-CONTENT");
    expect(preludeText).toContain("FALLBACK-UI");
    expect(preludeText).toContain(BOOTSTRAP_MARKER);
    // The live hole is aborted, so its content is absent from the shell.
    expect(preludeText).not.toContain("DYNAMIC-cap");

    // postponed is present (holes were pending) and JSON round-trips.
    expect(typeof result!.postponed).toBe("string");
    const parsed = JSON.parse(result!.postponed as string);
    expect(typeof parsed).toBe("object");
    expect(parsed).not.toBeNull();
    // Re-serialization is stable (the stored blob is what resume consumes).
    expect(JSON.stringify(parsed)).toBe(result!.postponed);
  });

  it("a REAL pending async promise (not never-resolving) is still a hole — the abort wins the race", async () => {
    // Under the task-based choreography real async I/O cannot beat the abort: a
    // promise that WILL resolve (after a delay) but has not by the time quiesce
    // fires postpones as a hole, exactly like a never-resolving one — its content
    // is absent from the frozen prelude. This pins "real I/O cannot win".
    let resolved = false;
    const realAsync = new Promise((r) => {
      const t = setTimeout(() => {
        resolved = true;
        r("late");
      }, 500);
      (t as { unref?: () => void }).unref?.();
    });
    mockedRenderSegments.mockImplementation(() =>
      Promise.resolve(makeTree(realAsync, "real")),
    );
    const capture = createShellCaptureHandler(makeDeps());
    const result = await capture(makeRscStream("REAL_ASYNC_FLIGHT"), {
      quiesce: Promise.resolve(),
    });
    expect(result).not.toBeNull();
    const preludeText = decoder.decode(result!.prelude);
    expect(preludeText).toContain("SHELL-CONTENT");
    expect(preludeText).toContain("FALLBACK-UI");
    expect(preludeText).not.toContain("DYNAMIC-real");
    // The abort froze the prelude before the 500ms promise settled.
    expect(resolved).toBe(false);
    expect(typeof result!.postponed).toBe("string");
  });

  it("(d) returns null when the shell postpones at the root (no <body>)", async () => {
    mockedRenderSegments.mockImplementation(() =>
      Promise.resolve(makeRootPostponeTree(new Promise(() => {}))),
    );
    const capture = createShellCaptureHandler(makeDeps());
    const result = await capture(makeRscStream("ROOT_POSTPONE_FLIGHT"), {
      quiesce: Promise.resolve(),
    });
    expect(result).toBeNull();
  });

  it("(f) respects maxWaitMs when quiesce never resolves", async () => {
    const start = Date.now();
    const result = await captureShell(makeDeps(), "cap", {
      quiesce: new Promise<void>(() => {}), // never resolves
      maxWaitMs: 50,
    });
    const elapsed = Date.now() - start;

    // It must not hang on the never-resolving quiesce: it aborts at maxWaitMs.
    expect(result).not.toBeNull();
    expect(decoder.decode(result!.prelude)).toContain("SHELL-CONTENT");
    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(2000);
  });

  it("bounds a hung bootstrap load under maxWaitMs (degrades to null, no hang)", async () => {
    // SSR-02: loadBootstrapScriptContent() was awaited BEFORE the maxWaitMs timer
    // was armed, so a hung bootstrap load hung captureShellHTML with no upper
    // bound and held the background capture task open. The deadline is now armed
    // first and the bootstrap load races it — a load that never resolves within
    // maxWaitMs is the same bounded no-shell degrade as a shell that never goes
    // quiet: null, not a hang. Before the fix this test hangs to the vitest
    // per-test timeout instead of resolving.
    const start = Date.now();
    const result = await captureShell(
      makeDeps({
        loadBootstrapScriptContent: vi.fn(() => new Promise<string>(() => {})),
      }),
      "cap",
      { maxWaitMs: 50 },
    );
    const elapsed = Date.now() - start;
    expect(result).toBeNull();
    // Bounded by the deadline, not hung.
    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(2000);
  });

  it("captures the DATA variant (no holes -> postponed null) with a healthy prelude", async () => {
    // No Suspense hole: the shell completes fully, so postponed is null.
    mockedRenderSegments.mockImplementation(() =>
      Promise.resolve(
        React.createElement(
          "html",
          null,
          React.createElement("body", null, "FULLY-STATIC-SHELL"),
        ),
      ),
    );
    const capture = createShellCaptureHandler(makeDeps());
    const result = await capture(makeRscStream("STATIC_FLIGHT"), {
      quiesce: Promise.resolve(),
    });
    expect(result).not.toBeNull();
    expect(decoder.decode(result!.prelude)).toContain("FULLY-STATIC-SHELL");
    expect(result!.postponed).toBeNull();
  });

  it("returns null (and does not hang) when tree-build awaits a masked loader", async () => {
    // The production incident behind this test: a loader route WITHOUT a
    // route-level loading() boundary awaits its loader data at TREE-BUILD
    // (renderSegments' loading-less branch, `await buildLoaderPromise`). Under
    // capture the loader is masked with a never-resolving promise, so
    // renderSegments' promise never settles, SsrRoot suspends at the root
    // (above <body>), and the prelude is empty. Capture must return null via
    // the sanity gate promptly after quiesce + abort - not hang, not throw.
    mockedRenderSegments.mockImplementation(() => new Promise<never>(() => {}));
    const capture = createShellCaptureHandler(makeDeps());
    const start = Date.now();
    const result = await capture(makeRscStream("TREE_AWAIT_FLIGHT"), {
      quiesce: Promise.resolve(),
      maxWaitMs: 5000,
    });
    expect(result).toBeNull();
    // Settles on the quiesce + two-macrotask + abort schedule, not maxWaitMs.
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("propagates a hard prerender rejection instead of returning null", async () => {
    const boom = new Error("prerender exploded");
    const deps = makeDeps({
      prerender: vi.fn().mockRejectedValue(boom) as any,
    });
    mockedRenderSegments.mockImplementation(() =>
      Promise.resolve(makeTree(new Promise(() => {}), "cap")),
    );
    const capture = createShellCaptureHandler(deps);
    await expect(
      capture(makeRscStream("F"), { quiesce: Promise.resolve() }),
    ).rejects.toThrow("prerender exploded");
  });

  it("returns null when the abort itself rejects the prerender (our abort reason)", async () => {
    // Dev cold paths: module transform / first-render latency can outlast
    // flight quiesce, so our own abort lands before the shell completed and
    // prerender REJECTS with the abort reason instead of returning a prelude.
    // Expected degradation, same class as a trivial prelude: null, no throw; a
    // later request re-captures. Discrimination is by IDENTITY, not error.name:
    // real react-dom aborts with `signal.reason` and rejects with that exact
    // object (capture's private abortReason), so this fake rejects with
    // `options.signal.reason` to mirror the real shape. The genuine-AbortError
    // test above pins that a NON-sentinel AbortError still propagates.
    const abortingPrerender = vi.fn(
      (_element: unknown, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => {
            reject(options.signal?.reason);
          });
        }),
    );
    const deps = makeDeps({ prerender: abortingPrerender as any });
    mockedRenderSegments.mockImplementation(() =>
      Promise.resolve(makeTree(new Promise(() => {}), "cap")),
    );
    const capture = createShellCaptureHandler(deps);
    const result = await capture(makeRscStream("ABORT_FLIGHT"), {
      quiesce: Promise.resolve(),
    });
    expect(result).toBeNull();
  });

  it("propagates a genuine AbortError-named throw (NOT our abort) instead of masking it as null", async () => {
    // Regression for SSR-01. A component throwing an error whose NAME is
    // "AbortError" (a component's own fetch/AbortController cancellation, a
    // nested boundary React aborts) is NOT capture's deliberate abort. Capture
    // aborts UNCONDITIONALLY before awaiting the prerender, so the old
    // discrimination `signal.aborted && error.name === "AbortError"` collapsed to
    // a pure name check and swallowed this genuine failure into a retryable null
    // no-shell — hiding it from reportCacheError. Identity discrimination
    // (error === abortReason) lets it propagate. A root throw is FATAL: real
    // react-dom/static.edge rejects the prerender with the thrown DOMException
    // (verified), so capture rethrows it rather than resolving null.
    const onError = vi.fn();
    const deps = makeDeps({ onError });
    mockedRenderSegments.mockImplementation(() =>
      Promise.resolve(
        React.createElement(
          "html",
          null,
          React.createElement(
            "body",
            null,
            React.createElement(function Boom(): React.ReactNode {
              throw new DOMException("genuine cancel", "AbortError");
            }),
          ),
        ),
      ),
    );
    const capture = createShellCaptureHandler(deps);
    await expect(
      capture(makeRscStream("GENUINE_ABORT_FLIGHT"), {
        quiesce: Promise.resolve(),
      }),
    ).rejects.toThrow("genuine cancel");
    // The genuine error also surfaced through the deps.onError channel.
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ name: "AbortError" }),
      { phase: "rendering" },
    );
  });

  it("releases the reader and cancels the source when the prelude stream errors mid-read", async () => {
    // SSR-05: readStreamToUint8Array had no try/finally, so a prelude that errors
    // mid-read (a documented abort path) propagated with the reader still locked
    // and the source uncancelled. A spy prelude stream observes that the throw
    // path now releases the lock and cancels the source before rethrowing. The
    // mid-read error is NOT our abort reason, so it propagates (not null).
    const midReadError = new Error("prelude stream boom mid-read");
    let released = false;
    let cancelledWith: unknown;
    const preludeStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("<body>partial"));
      },
      pull(controller) {
        controller.error(midReadError);
      },
    });
    const realGetReader = preludeStream.getReader.bind(preludeStream);
    preludeStream.getReader = (() => {
      const reader = (
        realGetReader as () => ReadableStreamDefaultReader<Uint8Array>
      )();
      const realRelease = reader.releaseLock.bind(reader);
      const realCancel = reader.cancel.bind(reader);
      reader.releaseLock = () => {
        released = true;
        realRelease();
      };
      reader.cancel = (reason?: unknown) => {
        cancelledWith = reason;
        return realCancel(reason);
      };
      return reader;
    }) as typeof preludeStream.getReader;

    const fakePrerender = vi
      .fn()
      .mockResolvedValue({ prelude: preludeStream, postponed: { s: 1 } });
    const deps = makeDeps({ prerender: fakePrerender as any });
    mockedRenderSegments.mockImplementation(() =>
      Promise.resolve(makeTree(new Promise(() => {}), "cap")),
    );
    const capture = createShellCaptureHandler(deps);
    await expect(
      capture(makeRscStream("MIDREAD_FLIGHT"), { quiesce: Promise.resolve() }),
    ).rejects.toThrow("prelude stream boom mid-read");
    expect(released).toBe(true);
    expect(cancelledWith).toBe(midReadError);
  });
});

describe("createShellResumeHandler", () => {
  it("(b) resumes a postponed shell into the hole content + $RC, without re-emitting the shell", async () => {
    const captured = await captureShell(makeDeps(), "cap");
    expect(captured).not.toBeNull();

    mockedRenderSegments.mockImplementation(() =>
      Promise.resolve(makeTree(Promise.resolve("ok"), "res")),
    );
    const resumeHandler = createShellResumeHandler(makeDeps());
    const stream = await resumeHandler(makeRscStream("RESUME_FLIGHT_BYTES"), {
      postponed: captured!.postponed,
    });
    const html = await readAll(stream);

    // Hole content + the stitch script that slots it into the prerendered shell.
    expect(html).toContain("DYNAMIC-res");
    expect(html).toContain("$RC");
    // The fresh hydration payload is injected.
    expect(html).toContain("__FLIGHT_DATA");
    expect(html).toContain("RESUME_FLIGHT_BYTES");
    // Resume must NOT re-emit the shell markup that already lives in the prelude.
    expect(html).not.toContain("SHELL-CONTENT");
    expect(html).not.toContain("FALLBACK-UI");
  });

  it("(c) composite prelude + resumed preserves shell-before-hole ordering", async () => {
    const captured = await captureShell(makeDeps(), "cap");
    expect(captured).not.toBeNull();

    mockedRenderSegments.mockImplementation(() =>
      Promise.resolve(makeTree(Promise.resolve("ok"), "res")),
    );
    const resumeHandler = createShellResumeHandler(makeDeps());
    const resumed = await resumeHandler(makeRscStream("COMPOSITE_FLIGHT"), {
      postponed: captured!.postponed,
    });

    // The middleware prepends the stored prelude bytes to the resumed stream.
    const composite =
      decoder.decode(captured!.prelude) + (await readAll(resumed));

    expect(composite).toContain("SHELL-CONTENT");
    expect(composite).toContain("FALLBACK-UI");
    expect(composite).toContain("DYNAMIC-res");
    expect(composite).toContain("$RC");
    // Shell (from prelude) comes before the live hole (from resume).
    expect(composite.indexOf("SHELL-CONTENT")).toBeLessThan(
      composite.indexOf("DYNAMIC-res"),
    );
  });

  it("(e) DATA variant (postponed null): emits only the Flight payload, no fizz, and terminates", async () => {
    const resumeSpy = vi.fn(resume) as any;
    const deps = makeDeps({ resume: resumeSpy });
    const resumeHandler = createShellResumeHandler(deps);

    const stream = await resumeHandler(makeRscStream("DATA_VARIANT_FLIGHT"), {
      postponed: null,
    });
    // readAll would reject on a hang (the empty-stream deadlock); it must close.
    const html = await readAll(stream);

    expect(html).toContain("__FLIGHT_DATA");
    expect(html).toContain("DATA_VARIANT_FLIGHT");
    expect(html.endsWith("</body></html>")).toBe(true);
    // No fizz output at all.
    expect(html).not.toContain("SHELL-CONTENT");
    expect(html).not.toContain("$RC");
    expect(html).not.toContain("DYNAMIC");
    expect(resumeSpy).not.toHaveBeenCalled();
  });

  it("DATA variant threads the nonce onto the injected payload scripts", async () => {
    const resumeHandler = createShellResumeHandler(makeDeps());
    const stream = await resumeHandler(makeRscStream("NONCED_FLIGHT"), {
      postponed: null,
      nonce: "abc123",
    });
    const html = await readAll(stream);
    expect(html).toContain('nonce="abc123"');
  });

  it("routes a resume setup error through onError with phase rendering, then errors the returned stream", async () => {
    // EAGER HANDOVER contract (ssr/index.tsx): resumeShellHTML returns the
    // injector's readable BEFORE awaiting resume(), so Flight bytes flow
    // immediately instead of waiting for the resume shell (which is gated on
    // the live loaders). A resume() failure therefore no longer rejects the
    // handler's promise — it aborts the injector's writable, and the error
    // surfaces when the returned stream is read (serveShellHit's reader loop,
    // which errors the response body). onError still fires with phase
    // "rendering" either way.
    const onError = vi.fn();
    const failing = vi.fn().mockRejectedValue(new Error("resume boom")) as any;
    const deps = makeDeps({ resume: failing, onError });
    mockedRenderSegments.mockImplementation(() =>
      Promise.resolve(makeTree(Promise.resolve("ok"), "res")),
    );
    const resumeHandler = createShellResumeHandler(deps);
    const stream = await resumeHandler(makeRscStream("X"), {
      postponed: "{}",
    });
    expect(stream).toBeInstanceOf(ReadableStream);
    await expect(readAll(stream)).rejects.toThrow("resume boom");
    expect(onError).toHaveBeenCalledWith(expect.any(Error), {
      phase: "rendering",
    });
  });

  it("throws a descriptive error resuming a postponed shell without the resume dep", async () => {
    const deps = makeDeps({ resume: undefined });
    mockedRenderSegments.mockImplementation(() =>
      Promise.resolve(makeTree(Promise.resolve("ok"), "res")),
    );
    const resumeHandler = createShellResumeHandler(deps);
    await expect(
      resumeHandler(makeRscStream("X"), { postponed: "{}" }),
    ).rejects.toThrow(/resume/);
  });
});

describe("createSSRHandler (regression: real tee + inject path)", () => {
  it("(g) composes fizz HTML with the injected Flight payload", async () => {
    mockedRenderSegments.mockImplementation(() =>
      Promise.resolve(
        React.createElement(
          "html",
          null,
          React.createElement(
            "body",
            null,
            React.createElement("div", null, "HELLO-SSR"),
          ),
        ),
      ),
    );
    const renderHTML = createSSRHandler(makeDeps());
    const stream = await renderHTML(makeRscStream("REGRESSION_FLIGHT"), {});
    const html = await readAll(stream);

    // Fizz-rendered shell.
    expect(html).toContain("HELLO-SSR");
    // Injected hydration payload from the teed second branch.
    expect(html).toContain("__FLIGHT_DATA");
    expect(html).toContain("REGRESSION_FLIGHT");
  });
});
