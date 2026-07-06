import { describe, it, expect, vi } from "vitest";
import React from "react";
import { preloadModule } from "react-dom";
import {
  createSSRHandler,
  installClientReferencePreinit,
  type SSRDependencies,
} from "../index";
import type { OnClientReference } from "../preinit-client-references.js";

// Mock renderSegments so SsrRoot can render without the full segment system
// (same setup as ssr-handler.test.tsx).
vi.mock("../../segment-system.js", () => ({
  renderSegments: vi.fn(() => Promise.resolve(React.createElement("div"))),
}));

import { renderSegments } from "../../segment-system.js";
import { renderToReadableStream as realRenderToReadableStream } from "react-dom/server";

const mockedRenderSegments = vi.mocked(renderSegments);

function createMockRscStream() {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("mock rsc payload"));
      controller.close();
    },
  });
}

async function consumeStream(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let html = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    html += decoder.decode(value, { stream: true });
  }
  return html + decoder.decode();
}

const passthroughInject = () =>
  vi.fn().mockReturnValue(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
      },
    }),
  );

describe("bootstrapModules conversion (resolveBootstrapOptions)", () => {
  const renderSpyDeps = (bootstrapContent: string) => {
    const renderToReadableStream = vi.fn().mockResolvedValue(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("<html></html>"));
          controller.close();
        },
      }),
    );
    const deps: SSRDependencies = {
      createFromReadableStream: vi.fn().mockResolvedValue({ metadata: {} }),
      renderToReadableStream,
      injectRSCPayload: passthroughInject(),
      loadBootstrapScriptContent: vi.fn().mockResolvedValue(bootstrapContent),
    };
    return { deps, renderToReadableStream };
  };

  // No default parameter: the undefined-headScripts case is itself under
  // test (a default would silently re-map an explicit undefined).
  const optionsAfterRender = async (
    content: string,
    headScripts: SSRDependencies["headScripts"],
  ) => {
    const { deps, renderToReadableStream } = renderSpyDeps(content);
    deps.headScripts = headScripts;
    await createSSRHandler(deps)(createMockRscStream());
    return renderToReadableStream.mock.calls[0]![1] as {
      bootstrapModules?: string[];
      bootstrapScriptContent?: string;
    };
  };

  it("converts the production import() bootstrap into bootstrapModules", async () => {
    const opts = await optionsAfterRender(
      'import("/assets/index-abc123.js")',
      "preinit",
    );
    expect(opts.bootstrapModules).toEqual(["/assets/index-abc123.js"]);
    expect(opts.bootstrapScriptContent).toBeUndefined();
  });

  it("converts the dev virtual-entry import() bootstrap", async () => {
    const opts = await optionsAfterRender(
      'import("/@id/__x00__virtual:vite-rsc/entry-browser")',
      "preinit",
    );
    expect(opts.bootstrapModules).toEqual([
      "/@id/__x00__virtual:vite-rsc/entry-browser",
    ]);
    expect(opts.bootstrapScriptContent).toBeUndefined();
  });

  it("tolerates whitespace, single quotes, and a trailing semicolon", async () => {
    const opts = await optionsAfterRender(
      "  import( '/assets/e.js' ) ; ",
      "preinit",
    );
    expect(opts.bootstrapModules).toEqual(["/assets/e.js"]);
  });

  it("falls back to bootstrapScriptContent for non-import content", async () => {
    const opts = await optionsAfterRender(
      "console.log('bootstrap')",
      "preinit",
    );
    expect(opts.bootstrapScriptContent).toBe("console.log('bootstrap')");
    expect(opts.bootstrapModules).toBeUndefined();
  });

  it("falls back for multi-statement content that merely starts with import()", async () => {
    const opts = await optionsAfterRender('import("/a.js");init()', "preinit");
    expect(opts.bootstrapScriptContent).toBe('import("/a.js");init()');
    expect(opts.bootstrapModules).toBeUndefined();
  });

  it('headScripts: "preload" keeps the inline bootstrap even for import() content', async () => {
    const opts = await optionsAfterRender(
      'import("/assets/index-abc123.js")',
      "preload",
    );
    expect(opts.bootstrapScriptContent).toBe(
      'import("/assets/index-abc123.js")',
    );
    expect(opts.bootstrapModules).toBeUndefined();
  });

  it("headScripts undefined (custom SSR entry) keeps the inline bootstrap verbatim", async () => {
    // Conversion is explicit-opt-in: a custom entry that predates the option
    // (and never installed the preinit hook) must not change output on
    // upgrade — e.g. a CSP that allowlists the inline import() by hash.
    const opts = await optionsAfterRender(
      'import("/assets/index-abc123.js")',
      undefined,
    );
    expect(opts.bootstrapScriptContent).toBe(
      'import("/assets/index-abc123.js")',
    );
    expect(opts.bootstrapModules).toBeUndefined();
  });
});

describe("installClientReferencePreinit (real fizz render)", () => {
  const realDeps = (): SSRDependencies => ({
    createFromReadableStream: vi.fn().mockResolvedValue({
      metadata: { pathname: "/", params: {}, matched: ["/"], segments: [] },
    }),
    renderToReadableStream: realRenderToReadableStream as never,
    injectRSCPayload: passthroughInject(),
    loadBootstrapScriptContent: vi.fn().mockResolvedValue(""),
  });

  /**
   * Capture the callback the installer registers, then fire it from inside a
   * rendered component — the same timing plugin-rsc uses (its resource proxy
   * calls preloadModule and then onClientReference synchronously during the
   * fizz render of the deserialized tree).
   */
  const installAndRender = async (opts: {
    href: string;
    nonce?: string;
    preloadFirst?: boolean;
  }) => {
    let onRef: OnClientReference | undefined;
    installClientReferencePreinit((cb) => {
      onRef = cb;
    });
    function ChunkUser() {
      if (opts.preloadFirst) {
        preloadModule(opts.href, { as: "script", crossOrigin: "" });
      }
      onRef!({ id: "src/Widget.tsx", deps: { js: [opts.href], css: [] } });
      return React.createElement("div", null, "ok");
    }
    mockedRenderSegments.mockImplementation(() =>
      Promise.resolve(React.createElement(ChunkUser)),
    );
    const renderHTML = createSSRHandler(realDeps());
    return consumeStream(
      await renderHTML(createMockRscStream(), { nonce: opts.nonce }),
    );
  };

  it("emits an executing module script for a client-reference chunk", async () => {
    const html = await installAndRender({ href: "/assets/chunk-a.js" });
    expect(html).toMatch(
      /<script[^>]*src="\/assets\/chunk-a\.js"[^>]*type="module"[^>]*async/,
    );
  });

  it("upgrades a queued preloadModule: executing script, no modulepreload left", async () => {
    const html = await installAndRender({
      href: "/assets/chunk-b.js",
      preloadFirst: true,
    });
    expect(html).toMatch(
      /<script[^>]*src="\/assets\/chunk-b\.js"[^>]*type="module"[^>]*async/,
    );
    // Fizz's preinitModuleScript clears the queued preload chunks for the same
    // href — the hint must not survive next to the executing tag.
    expect(html).not.toContain('rel="modulepreload"');
  });

  it("stamps the request nonce on preinit'd scripts through the ALS channel", async () => {
    const html = await installAndRender({
      href: "/assets/chunk-c.js",
      nonce: "test-nonce-123",
    });
    const tag = html.match(
      /<script[^>]*src="\/assets\/chunk-c\.js"[^>]*>/,
    )?.[0];
    expect(tag).toBeTruthy();
    expect(tag).toContain('nonce="test-nonce-123"');
  });
});
