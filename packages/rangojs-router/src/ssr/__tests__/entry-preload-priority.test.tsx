import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { preinitModule, preloadModule } from "react-dom";

// SsrRoot renders whatever renderSegments resolves; the segment system itself
// is not under test here.
vi.mock("../../segment-system.js", () => ({
  renderSegments: vi.fn(),
}));

import { renderSegments } from "../../segment-system.js";
import {
  createSSRHandler,
  createShellCaptureHandler,
  createShellResumeHandler,
  installClientReferencePreinit,
  type SSRDependencies,
} from "../index";
import type { OnClientReference } from "../preinit-client-references.js";
import {
  entryPreloadPriorityTransform,
  rewriteEntryPreloadPriority,
} from "../entry-preload-priority.js";
import { prerender } from "react-dom/static.edge";
import { renderToReadableStream, resume } from "react-dom/server.edge";
import { injectRSCPayload } from "rsc-html-stream/server";

const mockedRenderSegments = vi.mocked(renderSegments);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const ENTRY = "/assets/index-abc123.js";

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

function rscStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function deps(overrides: Partial<SSRDependencies> = {}): SSRDependencies {
  return {
    createFromReadableStream: vi.fn().mockResolvedValue({
      metadata: { pathname: "/", params: {}, matched: ["/"], segments: [] },
    }),
    renderToReadableStream: renderToReadableStream as never,
    injectRSCPayload: injectRSCPayload as never,
    prerender: prerender as never,
    resume: resume as never,
    headScripts: "preinit",
    getClientEntryUrl: () => ENTRY,
    ...overrides,
  };
}

/**
 * A document with an above-the-fold image, as in the #1025 fixture. `hole`
 * adds a Suspense boundary suspended on it (PPR capture/resume).
 * `entryCalls` replays what plugin-rsc's preloadDeps and the preinit hook do
 * for the entry chunk during the render: it is in every client reference's
 * `deps.js`.
 */
function documentTree(opts: { hole?: Promise<unknown>; entryCalls?: boolean }) {
  function EntryCalls() {
    if (opts.entryCalls) {
      preloadModule(ENTRY, { as: "script", crossOrigin: "" });
      preinitModule(ENTRY, { as: "script", crossOrigin: "" });
    }
    return null;
  }
  function Hole() {
    React.use(opts.hole!);
    return <p>HOLE-CONTENT</p>;
  }
  return (
    <html>
      <head>
        <title>t</title>
      </head>
      <body>
        <EntryCalls />
        <img src="/img/hero.jpg" width={1232} height={400} alt="" />
        <p>SHELL</p>
        {opts.hole && (
          <React.Suspense fallback={<span>FALLBACK</span>}>
            <Hole />
          </React.Suspense>
        )}
      </body>
    </html>
  );
}

const entryHints = (html: string): string[] =>
  html.match(
    new RegExp(`<link rel="modulepreload"[^>]*href="${ENTRY}"[^>]*>`, "g"),
  ) ?? [];
const entryScripts = (html: string): string[] =>
  html.match(new RegExp(`<script[^>]*src="${ENTRY}"[^>]*>`, "g")) ?? [];

afterEach(() => {
  mockedRenderSegments.mockReset();
});

describe("client entry hint priority (#1025): createSSRHandler, real Fizz", () => {
  const render = async (
    overrides: Partial<SSRDependencies>,
    nonce?: string,
    entryCalls = false,
  ) => {
    mockedRenderSegments.mockImplementation(() =>
      Promise.resolve(documentTree({ entryCalls })),
    );
    const renderHTML = createSSRHandler(deps(overrides));
    return readAll(await renderHTML(rscStream("FLIGHT"), { nonce }));
  };

  it("emits the entry modulepreload hint without fetchpriority, once, after the Fizz resource tags and before the app's head content", async () => {
    const html = await render({});
    const hints = entryHints(html);
    expect(hints).toEqual([`<link rel="modulepreload" href="${ENTRY}"/>`]);
    expect(html).toContain(`${hints[0]}<title>t</title></head>`);
    expect(html).not.toMatch(/fetchpriority/i);
  });

  it("places the entry hint after the head chunk scripts", async () => {
    let onRef: OnClientReference | undefined;
    installClientReferencePreinit((cb) => {
      onRef = cb;
    });
    function ChunkUser() {
      onRef!({
        id: "src/Widget.tsx",
        deps: { js: ["/assets/react-x.js"], css: [] },
      });
      return null;
    }
    mockedRenderSegments.mockImplementation(() =>
      Promise.resolve(
        <>
          <ChunkUser />
          {documentTree({})}
        </>,
      ),
    );
    const html = await readAll(
      await createSSRHandler(deps())(rscStream("FLIGHT")),
    );
    const chunkAt = html.indexOf('src="/assets/react-x.js"');
    expect(chunkAt).toBeGreaterThan(-1);
    expect(html.indexOf(entryHints(html)[0]!)).toBeGreaterThan(chunkAt);
  });

  it("keeps the executing end-of-shell bootstrap module script unchanged", async () => {
    const html = await render({});
    expect(entryScripts(html)).toEqual([
      `<script type="module" src="${ENTRY}" id="_R_" async="">`,
    ]);
    expect(html.indexOf(entryScripts(html)[0]!)).toBeGreaterThan(
      html.indexOf("SHELL"),
    );
  });

  it("stamps the request nonce on both the hint and the executing script", async () => {
    const html = await render({}, "n0nce+/=");
    expect(entryHints(html)).toEqual([
      `<link rel="modulepreload" nonce="n0nce+/=" href="${ENTRY}"/>`,
    ]);
    expect(entryScripts(html)).toEqual([
      `<script type="module" src="${ENTRY}" nonce="n0nce+/=" id="_R_" async="">`,
    ]);
  });

  it("plugin-rsc's preloadModule and the preinit hook stay inert for the entry: no second hint, no head script", async () => {
    const html = await render({}, undefined, true);
    expect(entryHints(html)).toHaveLength(1);
    expect(entryScripts(html)).toHaveLength(1);
    expect(entryScripts(html)[0]).toContain('id="_R_"');
  });

  it("a custom SSR entry whose inline bootstrap is exactly import(entry) gets the same moved hint", async () => {
    const html = await render({
      getClientEntryUrl: undefined,
      loadBootstrapScriptContent: async () => `import("${ENTRY}")`,
    });
    expect(entryHints(html)).toEqual([
      `<link rel="modulepreload" href="${ENTRY}"/>`,
    ]);
    expect(html).toContain(`${entryHints(html)[0]}<title>t</title></head>`);
    expect(entryScripts(html)).toHaveLength(1);
  });

  it("a custom SSR entry without headScripts keeps the inline bootstrap byte-for-byte and emits no entry hint", async () => {
    const html = await render({
      headScripts: undefined,
      getClientEntryUrl: undefined,
      loadBootstrapScriptContent: async () => `import("${ENTRY}")`,
    });
    expect(entryHints(html)).toEqual([]);
    expect(html).toContain(`import("${ENTRY}")</script>`);
  });

  it("a document without <html>/<head> gets the hint rewritten in place, and the shell is not held back", async () => {
    let release!: () => void;
    const hole = new Promise<void>((resolve) => {
      release = resolve;
    });
    function Hole() {
      React.use(hole);
      return <p>HOLE-CONTENT</p>;
    }
    mockedRenderSegments.mockImplementation(() =>
      Promise.resolve(
        <div>
          <p>SHELL</p>
          <React.Suspense fallback={<span>FALLBACK</span>}>
            <Hole />
          </React.Suspense>
        </div>,
      ),
    );
    const stream = await createSSRHandler(deps())(rscStream("FLIGHT"));
    const reader = stream.getReader();
    let early = "";
    while (!early.includes("FALLBACK")) {
      const { done, value } = await reader.read();
      expect(done, "the shell arrives before the hole resolves").toBe(false);
      early += decoder.decode(value);
    }
    expect(
      early.startsWith(`<link rel="modulepreload" href="${ENTRY}"/>`),
    ).toBe(true);
    expect(early).not.toContain("HOLE-CONTENT");
    release();
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += decoder.decode(value);
    }
    const html = early + rest;
    expect(html).toContain("HOLE-CONTENT");
    expect(entryHints(html)).toHaveLength(1);
    expect(html).not.toMatch(/fetchpriority/i);
  });

  it("streams the shell, moved hint included, before a pending Suspense hole resolves", async () => {
    let release!: (v: string) => void;
    const hole = new Promise<string>((resolve) => {
      release = resolve;
    });
    mockedRenderSegments.mockImplementation(() =>
      Promise.resolve(documentTree({ hole })),
    );
    const stream = await createSSRHandler(deps())(rscStream("FLIGHT"));
    const reader = stream.getReader();
    let early = "";
    while (!early.includes("FALLBACK")) {
      const { done, value } = await reader.read();
      expect(done, "the shell arrives before the hole resolves").toBe(false);
      early += decoder.decode(value);
    }
    expect(early).toContain(
      `<link rel="modulepreload" href="${ENTRY}"/><title>t</title></head>`,
    );
    expect(early).not.toContain("HOLE-CONTENT");
    release("ok");
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += decoder.decode(value);
    }
    expect(rest).toContain("HOLE-CONTENT");
    expect(entryHints(early + rest)).toHaveLength(1);
  });

  it('headScripts: "preload" keeps the inline import() bootstrap and emits no entry hint', async () => {
    const html = await render({
      headScripts: "preload",
      getClientEntryUrl: undefined,
      loadBootstrapScriptContent: async () => `import("${ENTRY}")`,
    });
    expect(entryHints(html)).toEqual([]);
    expect(html).toContain(`import("${ENTRY}")</script>`);
  });
});

describe("client entry hint priority (#1025): PPR capture and resume", () => {
  const capture = async () => {
    mockedRenderSegments.mockImplementation(() =>
      Promise.resolve(documentTree({ hole: new Promise(() => {}) })),
    );
    const result = await createShellCaptureHandler(deps())(
      rscStream("CAPTURE_FLIGHT"),
      { quiesce: Promise.resolve() },
    );
    expect(result).not.toBeNull();
    return result!;
  };

  it("the stored prelude carries the entry hint without fetchpriority, once", async () => {
    const prelude = decoder.decode((await capture()).prelude);
    expect(entryHints(prelude)).toEqual([
      `<link rel="modulepreload" href="${ENTRY}"/>`,
    ]);
    expect(prelude).toContain(
      `${entryHints(prelude)[0]}<title>t</title></head>`,
    );
    expect(entryScripts(prelude)).toHaveLength(1);
    expect(prelude).not.toMatch(/fetchpriority/i);
  });

  it("the resumed tail re-emits neither the hint nor the bootstrap script", async () => {
    const captured = await capture();
    mockedRenderSegments.mockImplementation(() =>
      Promise.resolve(documentTree({ hole: Promise.resolve("ok") })),
    );
    const tail = await readAll(
      await createShellResumeHandler(deps())(rscStream("RESUME_FLIGHT"), {
        postponed: captured.postponed,
      }),
    );
    expect(tail).toContain("HOLE-CONTENT");
    expect(entryHints(tail)).toEqual([]);
    expect(entryScripts(tail)).toEqual([]);
  });
});

/**
 * App head content Fizz writes after the hint and its resource run, holding
 * text React does not escape inside raw-text elements. The hint must land
 * between the chunk script and that content, never inside it.
 */
describe("client entry hint priority (#1025): app head content after the hint, real Fizz", () => {
  const CHUNK = "/assets/react-x.js";
  function ChunkScript() {
    preinitModule(CHUNK, { as: "script" });
    return null;
  }
  const cases: Record<string, { head: React.ReactNode; raw: string }> = {
    "script text": {
      head: (
        <script dangerouslySetInnerHTML={{ __html: 'var s = "<body>";' }} />
      ),
      raw: '<script>var s = "<body>";</script>',
    },
    "JSON-LD": {
      head: (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: '{"a":"</head><body>"}' }}
        />
      ),
      raw: '<script type="application/ld+json">{"a":"</head><body>"}</script>',
    },
    style: {
      head: <style>{"/* <body */ p{}"}</style>,
      raw: "<style>/* <body */ p{}</style>",
    },
  };

  async function fizzBytes(head: React.ReactNode): Promise<Uint8Array> {
    const stream = await renderToReadableStream(
      <html>
        <head>
          <ChunkScript />
          {head}
        </head>
        <body>
          <p>x</p>
        </body>
      </html>,
      { bootstrapModules: [ENTRY], nonce: "n0" },
    );
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function through(chunks: Uint8Array[]): Promise<Uint8Array> {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });
    return new Uint8Array(
      await new Response(
        source.pipeThrough(entryPreloadPriorityTransform(ENTRY, "n0")),
      ).arrayBuffer(),
    );
  }

  for (const [name, { head, raw }] of Object.entries(cases)) {
    it(`${name}: the hint goes after the chunk script and before the app's tag, wherever a chunk boundary splits the document`, async () => {
      const full = await fizzBytes(head);
      const source = decoder.decode(full);
      expect(source).toContain(raw);
      const auto = `<link rel="modulepreload" nonce="n0" href="${ENTRY}"/>`;
      const low = `<link rel="modulepreload" fetchPriority="low" nonce="n0" href="${ENTRY}"/>`;
      expect(source).toContain(low);
      const chunkAt = source.indexOf(`src="${CHUNK}"`);
      expect(chunkAt).toBeGreaterThan(-1);
      const chunkEnd =
        source.indexOf("</script>", chunkAt) + "</script>".length;
      const chunkTag = source.slice(
        source.lastIndexOf("<script", chunkAt),
        chunkEnd,
      );
      const expected = source
        .replace(low, "")
        .replace(chunkTag, chunkTag + auto);
      expect(expected).toContain(`${chunkTag}${auto}`);
      expect(expected).toContain(raw);

      expect(
        decoder.decode(rewriteEntryPreloadPriority(full, ENTRY, "n0")),
      ).toBe(expected);
      for (let cut = 1; cut < full.length; cut++) {
        const out = await through([full.slice(0, cut), full.slice(cut)]);
        expect(decoder.decode(out), `cut at ${cut}`).toBe(expected);
      }
      const bytewise = await through([...full].map((b) => Uint8Array.of(b)));
      expect(decoder.decode(bytewise)).toBe(expected);
    });
  }
});

describe("entryPreloadPriorityTransform", () => {
  const LOW = `<link rel="modulepreload" fetchPriority="low" nonce="abc" href="${ENTRY}"/>`;
  const AUTO = `<link rel="modulepreload" nonce="abc" href="${ENTRY}"/>`;
  const DOC = `<!DOCTYPE html><html><head><meta charSet="utf-8"/>${LOW}<script src="/a.js" type="module" async=""></script></head><body><p>x</p><script type="module" src="${ENTRY}" nonce="abc" id="_R_" async=""></script></body></html>`;

  async function pipe(chunks: string[], nonce?: string): Promise<string[]> {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    const out: string[] = [];
    const reader = source
      .pipeThrough(entryPreloadPriorityTransform(ENTRY, nonce))
      .getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return out;
      out.push(decoder.decode(value));
    }
  }

  const EXPECTED = DOC.replace(LOW, "").replace("</head>", `${AUTO}</head>`);

  it("moves the hint after the chunk script without fetchPriority", async () => {
    expect((await pipe([DOC], "abc")).join("")).toBe(EXPECTED);
  });

  it("rewrites the hint wherever a chunk boundary splits the document", async () => {
    for (let cut = 1; cut < DOC.length; cut++) {
      const out = await pipe([DOC.slice(0, cut), DOC.slice(cut)], "abc");
      expect(out.join(""), `cut at ${cut}`).toBe(EXPECTED);
    }
  });

  it("rewrites the hint when the document arrives a byte at a time", async () => {
    const out = await pipe([...DOC], "abc");
    expect(out.join("")).toBe(EXPECTED);
  });

  it("puts a removed hint back in place when the stream ends inside the head", async () => {
    const open = `<head>${LOW}<title>t</title>`;
    expect((await pipe([open], "abc")).join("")).toBe(
      `<head>${AUTO}<title>t</title>`,
    );
  });

  it("rewrites in place, without buffering, when no <head precedes the hint", async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const reader = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
      },
    })
      .pipeThrough(entryPreloadPriorityTransform(ENTRY, "abc"))
      .getReader();
    source.enqueue(encoder.encode(`${LOW}<div>shell</div>`));
    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe(`${AUTO}<div>shell</div>`);
    source.enqueue(encoder.encode("<div>later</div>"));
    expect(decoder.decode((await reader.read()).value)).toBe(
      "<div>later</div>",
    );
    source.close();
    expect((await reader.read()).done).toBe(true);
  });

  it("forwards everything after the head without holding it back", async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const reader = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
      },
    })
      .pipeThrough(entryPreloadPriorityTransform(ENTRY, "abc"))
      .getReader();
    source.enqueue(encoder.encode(`<html><head>${LOW}</head><body><p>shell`));
    let head = "";
    while (!head.endsWith("<p>shell")) {
      head += decoder.decode((await reader.read()).value);
    }
    expect(head).toBe(`<html><head>${AUTO}</head><body><p>shell`);
    // A trailing "<" could start a split tag; past the head it is not held.
    source.enqueue(encoder.encode("</p><"));
    expect(decoder.decode((await reader.read()).value)).toBe("</p><");
    source.close();
  });

  it("forwards a chunk that ends mid-document without holding it back", async () => {
    const out = await pipe(["<head><title>t</title>", "</head><body>"], "abc");
    expect(out[0]).toBe("<head><title>t</title>");
  });

  it("a multi-megabyte head streams through in bounded chunks and linear time", async () => {
    const tags = Array.from(
      { length: 40000 },
      (_, i) =>
        `<script src="/assets/c-${i}.js" type="module" async=""></script>`,
    ).join("");
    const json = `<script type="application/ld+json">${"x".repeat(1_500_000)}</script>`;
    const doc = `<html><head>${LOW}${tags}${json}<title>t</title></head><body><p>x</p></body></html>`;
    const bytes = encoder.encode(doc);
    const SIZE = 4096;
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += SIZE) {
      chunks.push(bytes.slice(i, i + SIZE));
    }
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });
    const started = performance.now();
    const reader = source
      .pipeThrough(entryPreloadPriorityTransform(ENTRY, "abc"))
      .getReader();
    const out: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(value);
    }
    const elapsed = performance.now() - started;
    // Held bytes stay bounded: no output chunk carries more than one input
    // chunk plus an unfinished tag (MAX_HELD_TAG) and the moved hint.
    expect(Math.max(...out.map((c) => c.length))).toBeLessThan(
      2 * SIZE + 8192 + AUTO.length,
    );
    const html = out.map((c) => decoder.decode(c)).join("");
    expect(html).toBe(doc.replace(LOW, "").replace(json, AUTO + json));
    // ~4.3 MB in ~1050 chunks; the quadratic buffer took seconds here.
    expect(elapsed).toBeLessThan(1500);
  });

  it("leaves bytes untouched when the nonce or URL differs", async () => {
    expect((await pipe([DOC], "other")).join("")).toBe(DOC);
    expect((await pipe([DOC])).join("")).toBe(DOC);
  });

  it("stops at <body: a matching tag after it is not rewritten, wherever a chunk boundary splits the document", async () => {
    const late = `<html><head></head><body>${LOW}</body></html>`;
    expect((await pipe([late], "abc")).join("")).toBe(late);
    for (let cut = 1; cut < late.length; cut++) {
      const out = await pipe([late.slice(0, cut), late.slice(cut)], "abc");
      expect(out.join(""), `cut at ${cut}`).toBe(late);
    }
  });

  it("does not touch other low-priority modulepreload hints", async () => {
    const other = `<head><link rel="modulepreload" fetchPriority="low" href="/assets/other.js"/></head><body>`;
    expect((await pipe([other])).join("")).toBe(other);
  });

  it("rewriteEntryPreloadPriority rewrites a complete prelude and escapes like Fizz", () => {
    expect(
      decoder.decode(
        rewriteEntryPreloadPriority(encoder.encode(DOC), ENTRY, "abc"),
      ),
    ).toBe(EXPECTED);
    const url = "/assets/a&b.js";
    const low = `<head><link rel="modulepreload" fetchPriority="low" href="/assets/a&amp;b.js"/><script src="/x.js"></script></head>`;
    expect(
      decoder.decode(rewriteEntryPreloadPriority(encoder.encode(low), url)),
    ).toBe(
      `<head><script src="/x.js"></script><link rel="modulepreload" href="/assets/a&amp;b.js"/></head>`,
    );
    const none = encoder.encode("<head></head><body>");
    expect(rewriteEntryPreloadPriority(none, ENTRY)).toBe(none);
    // No <head before the hint: in place, never appended past the prelude.
    const headless = `<link rel="modulepreload" fetchPriority="low" href="${ENTRY}"/><div>x</div>`;
    expect(
      decoder.decode(
        rewriteEntryPreloadPriority(encoder.encode(headless), ENTRY),
      ),
    ).toBe(`<link rel="modulepreload" href="${ENTRY}"/><div>x</div>`);
  });
});
