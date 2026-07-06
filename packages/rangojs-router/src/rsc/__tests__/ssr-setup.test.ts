import { describe, expect, it, vi } from "vitest";
import {
  isRscRequest,
  mayNeedSSR,
  startSSRSetup,
  getSSRSetup,
} from "../ssr-setup.js";
import type { MetricsStore } from "../../server/context.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../server/request-context.js";
import type { HandlerContext } from "../handler-context.js";
import type { SSRModule } from "../types.js";
import type { SSRStreamMode } from "../../router/router-options.js";

function createMockCtx(
  overrides: Partial<{
    ssrModule: SSRModule;
    streamMode: SSRStreamMode;
    loadDelay: number;
    streamModeDelay: number;
  }> = {},
): HandlerContext<unknown> {
  const ssrModule: SSRModule =
    overrides.ssrModule ??
    ({ renderHTML: vi.fn(async () => new ReadableStream()) } as any);
  const streamMode: SSRStreamMode = overrides.streamMode ?? "stream";
  const loadDelay = overrides.loadDelay ?? 0;
  const streamModeDelay = overrides.streamModeDelay ?? 0;

  return {
    loadSSRModule: () =>
      loadDelay > 0
        ? new Promise((r) => setTimeout(() => r(ssrModule), loadDelay))
        : Promise.resolve(ssrModule),
    resolveStreamMode: () =>
      streamModeDelay > 0
        ? new Promise((r) => setTimeout(() => r(streamMode), streamModeDelay))
        : Promise.resolve(streamMode),
  } as any;
}

function createMetricsStore(): MetricsStore {
  return { enabled: true, requestStart: performance.now(), metrics: [] };
}

describe("mayNeedSSR", () => {
  it("returns true for plain HTML requests", () => {
    const req = new Request("http://localhost/");
    const url = new URL(req.url);
    expect(mayNeedSSR(req, url)).toBe(true);
  });

  it("returns false for _rsc_partial", () => {
    const req = new Request("http://localhost/?_rsc_partial=1");
    expect(mayNeedSSR(req, new URL(req.url))).toBe(false);
  });

  it("returns false for _rsc_action query param", () => {
    const req = new Request("http://localhost/?_rsc_action=save");
    expect(mayNeedSSR(req, new URL(req.url))).toBe(false);
  });

  it("returns false for rsc-action header", () => {
    const req = new Request("http://localhost/", {
      headers: { "rsc-action": "save" },
    });
    expect(mayNeedSSR(req, new URL(req.url))).toBe(false);
  });

  it("returns false for _rsc_loader", () => {
    const req = new Request("http://localhost/?_rsc_loader=1");
    expect(mayNeedSSR(req, new URL(req.url))).toBe(false);
  });

  it("returns false for __rsc forced RSC", () => {
    const req = new Request("http://localhost/?__rsc=1");
    expect(mayNeedSSR(req, new URL(req.url))).toBe(false);
  });

  it("returns false for __prerender_collect", () => {
    const req = new Request("http://localhost/?__prerender_collect=1");
    expect(mayNeedSSR(req, new URL(req.url))).toBe(false);
  });

  it("returns true for POST form submissions (PE path)", () => {
    const req = new Request("http://localhost/submit", { method: "POST" });
    expect(mayNeedSSR(req, new URL(req.url))).toBe(true);
  });

  it("returns false for explicit Accept: text/x-component", () => {
    const req = new Request("http://localhost/", {
      headers: { accept: "text/x-component" },
    });
    expect(mayNeedSSR(req, new URL(req.url))).toBe(false);
  });

  it("returns true for Accept-based RSC requests with __html override", () => {
    const req = new Request("http://localhost/?__html=1", {
      headers: { accept: "text/x-component" },
    });
    expect(mayNeedSSR(req, new URL(req.url))).toBe(true);
  });

  it("returns true when Accept includes text/html", () => {
    const req = new Request("http://localhost/", {
      headers: { accept: "text/html, */*" },
    });
    expect(mayNeedSSR(req, new URL(req.url))).toBe(true);
  });

  // Flight is explicit-opt-in only: a generic client (curl's */*, a missing
  // Accept, or a mismatched type like application/json) gets the HTML
  // document. The old rule (no text/html substring → RSC) served the wire
  // format to every generic HTTP client.
  it("returns true for Accept: */* (generic client)", () => {
    const req = new Request("http://localhost/", {
      headers: { accept: "*/*" },
    });
    expect(mayNeedSSR(req, new URL(req.url))).toBe(true);
  });

  it("returns true for Accept: application/json (no flight opt-in)", () => {
    const req = new Request("http://localhost/", {
      headers: { accept: "application/json" },
    });
    expect(mayNeedSSR(req, new URL(req.url))).toBe(true);
  });

  it("returns true when text/html outranks text/x-component", () => {
    const req = new Request("http://localhost/", {
      headers: { accept: "text/html, text/x-component;q=0.5" },
    });
    expect(mayNeedSSR(req, new URL(req.url))).toBe(true);
  });

  it("returns false when text/x-component outranks text/html", () => {
    const req = new Request("http://localhost/", {
      headers: { accept: "text/x-component, text/html;q=0.5" },
    });
    expect(mayNeedSSR(req, new URL(req.url))).toBe(false);
  });

  it("returns true when text/x-component is refused with q=0", () => {
    const req = new Request("http://localhost/", {
      headers: { accept: "text/x-component;q=0" },
    });
    expect(mayNeedSSR(req, new URL(req.url))).toBe(true);
  });

  it("returns true when a wildcard outranks text/x-component", () => {
    // */* expresses "anything"; the canonical representation is the document.
    const req = new Request("http://localhost/", {
      headers: { accept: "*/*, text/x-component;q=0.5" },
    });
    expect(mayNeedSSR(req, new URL(req.url))).toBe(true);
  });
});

// isRscRequest must agree with mayNeedSSR on the Accept rule — see
// mayNeedSSR's doc for the document-cache invariant this protects.
describe("isRscRequest", () => {
  function req(accept?: string, path = "/"): [Request, URL] {
    const r = new Request(`http://localhost${path}`, {
      headers: accept === undefined ? {} : { accept },
    });
    return [r, new URL(r.url)];
  }

  it("returns true for partial renders regardless of Accept", () => {
    const [r, u] = req("text/html");
    expect(isRscRequest(r, u, true)).toBe(true);
  });

  it("returns true for __rsc regardless of Accept", () => {
    const [r, u] = req("text/html", "/?__rsc=1");
    expect(isRscRequest(r, u, false)).toBe(true);
  });

  it("returns true for _rsc_partial in the URL even when the plan lost it", () => {
    // The 404 fallback plan hardcodes full-render (isPartial=false) for
    // partial navigations to unknown routes; the URL param must still force
    // flight or the client receives an HTML 404 it cannot apply.
    const [r, u] = req("*/*", "/?_rsc_partial=true");
    expect(isRscRequest(r, u, false)).toBe(true);
  });

  it("returns true for explicit Accept: text/x-component", () => {
    const [r, u] = req("text/x-component");
    expect(isRscRequest(r, u, false)).toBe(true);
  });

  it("returns false for a missing Accept header", () => {
    const [r, u] = req(undefined);
    expect(isRscRequest(r, u, false)).toBe(false);
  });

  it("returns false for Accept: */*", () => {
    const [r, u] = req("*/*");
    expect(isRscRequest(r, u, false)).toBe(false);
  });

  it("returns false for Accept: application/json", () => {
    const [r, u] = req("application/json");
    expect(isRscRequest(r, u, false)).toBe(false);
  });

  it("returns false for a browser Accept header", () => {
    const [r, u] = req(
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    );
    expect(isRscRequest(r, u, false)).toBe(false);
  });

  it("returns false for text/x-component with __html override", () => {
    const [r, u] = req("text/x-component", "/?__html=1");
    expect(isRscRequest(r, u, false)).toBe(false);
  });

  it("ranks text/html above a lower-q text/x-component", () => {
    const [r, u] = req("text/html, text/x-component;q=0.5");
    expect(isRscRequest(r, u, false)).toBe(false);
  });

  it("ranks text/x-component above a lower-q text/html", () => {
    const [r, u] = req("text/x-component, text/html;q=0.5");
    expect(isRscRequest(r, u, false)).toBe(true);
  });

  it("agrees with mayNeedSSR across the Accept matrix", () => {
    const accepts = [
      undefined,
      "",
      "*/*",
      "text/html",
      "application/json",
      "text/x-component",
      "text/html, text/x-component;q=0.5",
      "text/x-component, text/html;q=0.5",
      "text/x-component;q=0",
      "*/*, text/x-component;q=0.5",
    ];
    for (const accept of accepts) {
      const [r, u] = req(accept);
      expect(isRscRequest(r, u, false), `accept: ${String(accept)}`).toBe(
        !mayNeedSSR(r, u),
      );
    }
  });
});

describe("startSSRSetup", () => {
  it("resolves with [SSRModule, SSRStreamMode] tuple", async () => {
    const ctx = createMockCtx();
    const [mod, mode] = await startSSRSetup(
      ctx,
      new Request("http://localhost/"),
      {},
      new URL("http://localhost/"),
      () => undefined,
    );
    expect(mod).toBeDefined();
    expect(mod.renderHTML).toBeDefined();
    expect(mode).toBe("stream");
  });

  it("records ssr:module-load and ssr:stream-mode metrics", async () => {
    const metrics = createMetricsStore();
    const ctx = createMockCtx({ loadDelay: 5, streamModeDelay: 1 });
    await startSSRSetup(
      ctx,
      new Request("http://localhost/"),
      {},
      new URL("http://localhost/"),
      () => metrics,
    );
    const labels = metrics.metrics.map((m) => m.label);
    expect(labels).toContain("ssr:module-load");
    expect(labels).toContain("ssr:stream-mode");
    expect(metrics.metrics).toHaveLength(2);
  });

  it("skips metrics when store getter returns undefined", async () => {
    const ctx = createMockCtx();
    const [mod, mode] = await startSSRSetup(
      ctx,
      new Request("http://localhost/"),
      {},
      new URL("http://localhost/"),
      () => undefined,
    );
    expect(mod).toBeDefined();
    expect(mode).toBe("stream");
  });

  it("skips .then() wrappers when no getter is provided", async () => {
    const ctx = createMockCtx();
    const [mod, mode] = await startSSRSetup(
      ctx,
      new Request("http://localhost/"),
      {},
      new URL("http://localhost/"),
    );
    expect(mod).toBeDefined();
    expect(mod.renderHTML).toBeDefined();
    expect(mode).toBe("stream");
  });
});

describe("getSSRSetup", () => {
  it("returns the early promise when available on request context", async () => {
    const ctx = createMockCtx();
    const earlyPromise = startSSRSetup(
      ctx,
      new Request("http://localhost/"),
      {},
      new URL("http://localhost/"),
      () => undefined,
    );

    const reqCtx = createRequestContext({
      env: {},
      request: new Request("http://localhost/"),
      url: new URL("http://localhost/"),
      variables: { __ssrSetup: earlyPromise },
    });

    const result = await runWithRequestContext(reqCtx, () =>
      getSSRSetup(
        ctx,
        new Request("http://localhost/"),
        {},
        new URL("http://localhost/"),
        undefined,
      ),
    );

    expect(result).toBe(await earlyPromise);
  });

  it("starts a fresh setup when no early promise exists", async () => {
    const ctx = createMockCtx();

    const reqCtx = createRequestContext({
      env: {},
      request: new Request("http://localhost/"),
      url: new URL("http://localhost/"),
      variables: {},
    });

    const [mod, mode] = await runWithRequestContext(reqCtx, () =>
      getSSRSetup(
        ctx,
        new Request("http://localhost/"),
        {},
        new URL("http://localhost/"),
        undefined,
      ),
    );

    expect(mod).toBeDefined();
    expect(mode).toBe("stream");
  });

  it("falls back gracefully outside request context", async () => {
    const ctx = createMockCtx();
    const [mod, mode] = await getSSRSetup(
      ctx,
      new Request("http://localhost/"),
      {},
      new URL("http://localhost/"),
      undefined,
    );
    expect(mod).toBeDefined();
    expect(mode).toBe("stream");
  });
});
