import { describe, expect, it, vi } from "vitest";
import { mayNeedSSR, startSSRSetup, getSSRSetup } from "../ssr-setup.js";
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

  it("returns false for Accept-based RSC requests (no text/html)", () => {
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

  it("skips metrics when store is undefined", async () => {
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
