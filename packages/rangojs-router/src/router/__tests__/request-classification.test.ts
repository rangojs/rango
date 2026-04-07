import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../manifest.js", () => ({
  loadManifest: vi.fn(),
}));

vi.mock("../middleware.js", () => ({
  collectRouteMiddleware: vi.fn(() => []),
}));

vi.mock("../../cache/cache-scope.js", () => ({
  createCacheScope: vi.fn(() => null),
}));

import {
  classifyRequest,
  type RequestPlan,
} from "../request-classification.js";
import { loadManifest } from "../manifest.js";
import { collectRouteMiddleware } from "../middleware.js";
import type { RouteMatchResult } from "../pattern-matching.js";

const mockLoadManifest = vi.mocked(loadManifest);
const mockCollectRouteMiddleware = vi.mocked(collectRouteMiddleware);

function makeMatch(overrides?: Partial<RouteMatchResult>): RouteMatchResult {
  return {
    entry: {} as any,
    routeKey: "test",
    params: {},
    optionalParams: new Set<string>(),
    ...overrides,
  } as RouteMatchResult;
}

function makeEntry(overrides?: Record<string, any>) {
  return {
    type: "route" as const,
    shortCode: "R0",
    parent: null,
    cache: undefined,
    handler: vi.fn(),
    ...overrides,
  } as any;
}

function makeRequest(
  urlStr: string,
  init?: RequestInit & { headers?: Record<string, string> },
): { request: Request; url: URL } {
  const url = new URL(urlStr);
  const request = new Request(urlStr, {
    method: init?.method ?? "GET",
    headers: new Headers(init?.headers),
  });
  return { request, url };
}

function makeDeps(overrides?: Partial<Parameters<typeof classifyRequest>[2]>) {
  return {
    findMatch: vi.fn(() => makeMatch()),
    routerVersion: "1.0.0",
    routerId: "test-router",
    ...overrides,
  };
}

describe("classifyRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadManifest.mockResolvedValue(makeEntry());
    mockCollectRouteMiddleware.mockReturnValue([]);
  });

  // ---- No match ----

  it("throws RouteNotFoundError when no route matches", async () => {
    const { request, url } = makeRequest("http://localhost/unknown");
    const deps = makeDeps({ findMatch: () => null });

    await expect(classifyRequest(request, url, deps)).rejects.toThrow(
      "No route matched",
    );
  });

  // ---- Redirect ----

  it("classifies redirect routes", async () => {
    const { request, url } = makeRequest("http://localhost/old?q=1");
    const deps = makeDeps({
      findMatch: () => makeMatch({ redirectTo: "/new" }),
    });

    const plan = await classifyRequest(request, url, deps);

    expect(plan.mode).toBe("redirect");
    if (plan.mode === "redirect") {
      expect(plan.redirectUrl).toBe("/new?q=1");
    }
  });

  // ---- Version mismatch ----

  it("classifies version mismatch", async () => {
    const { request, url } = makeRequest(
      "http://localhost/page?_rsc_v=0.9.0&_rsc_partial=1",
    );
    const deps = makeDeps({ routerVersion: "1.0.0" });

    const plan = await classifyRequest(request, url, deps);

    expect(plan.mode).toBe("version-mismatch");
  });

  it("version mismatch on removed route produces reload, not 404", async () => {
    const { request, url } = makeRequest(
      "http://localhost/removed?_rsc_v=0.9.0&_rsc_partial=1",
    );
    // Route no longer exists — findMatch returns null
    const deps = makeDeps({
      findMatch: () => null,
      routerVersion: "1.0.0",
    });

    const plan = await classifyRequest(request, url, deps);

    // Should be version-mismatch (reload), NOT throw RouteNotFoundError
    expect(plan.mode).toBe("version-mismatch");
  });

  it("version mismatch reload URL strips _rsc_* params", async () => {
    const { request, url } = makeRequest(
      "http://localhost/page?_rsc_v=0.9.0&_rsc_partial=1&_rsc_segments=L0,R1&user=alice",
    );
    const deps = makeDeps({ routerVersion: "1.0.0" });

    const plan = await classifyRequest(request, url, deps);

    expect(plan.mode).toBe("version-mismatch");
    if (plan.mode === "version-mismatch") {
      // Should not contain _rsc_* params, but should keep user params
      expect(plan.reloadUrl).not.toContain("_rsc_v");
      expect(plan.reloadUrl).not.toContain("_rsc_partial");
      expect(plan.reloadUrl).not.toContain("_rsc_segments");
      expect(plan.reloadUrl).toContain("user=alice");
    }
  });

  it("version mismatch uses referer for action requests", async () => {
    const { request, url } = makeRequest(
      "http://localhost/page?_rsc_v=0.9.0&_rsc_action=hash%23test",
      {
        headers: {
          "rsc-action": "hash#test",
          referer: "http://localhost/source",
        },
      },
    );
    const deps = makeDeps({ routerVersion: "1.0.0" });

    const plan = await classifyRequest(request, url, deps);

    expect(plan.mode).toBe("version-mismatch");
    if (plan.mode === "version-mismatch") {
      expect(plan.reloadUrl).toBe("http://localhost/source");
    }
  });

  it("skips version mismatch when versions match", async () => {
    const { request, url } = makeRequest("http://localhost/page?_rsc_v=1.0.0");
    const deps = makeDeps({ routerVersion: "1.0.0" });

    const plan = await classifyRequest(request, url, deps);

    expect(plan.mode).not.toBe("version-mismatch");
  });

  // ---- Response route ----

  it("classifies response routes", async () => {
    const handler = vi.fn();
    mockLoadManifest.mockResolvedValue(
      makeEntry({ type: "route", handler, responseType: "application/json" }),
    );
    const { request, url } = makeRequest("http://localhost/api/data");
    const deps = makeDeps({
      findMatch: () => makeMatch({ responseType: "application/json" }),
    });

    const plan = await classifyRequest(request, url, deps);

    expect(plan.mode).toBe("response");
    if (plan.mode === "response") {
      expect(plan.responseType).toBe("application/json");
      expect(plan.handler).toBe(handler);
      expect(plan.negotiated).toBe(false);
    }
  });

  it("does not classify RSC routes as response routes", async () => {
    mockLoadManifest.mockResolvedValue(makeEntry({ type: "route" }));
    const { request, url } = makeRequest("http://localhost/page");
    const deps = makeDeps();

    const plan = await classifyRequest(request, url, deps);

    expect(plan.mode).not.toBe("response");
  });

  // ---- Action ----

  it("classifies action by rsc-action header", async () => {
    const { request, url } = makeRequest("http://localhost/page", {
      method: "POST",
      headers: { "rsc-action": "hash#myAction" },
    });
    const deps = makeDeps();

    const plan = await classifyRequest(request, url, deps);

    expect(plan.mode).toBe("action");
    if (plan.mode === "action") {
      expect(plan.actionId).toBe("hash#myAction");
    }
  });

  it("classifies action by _rsc_action param", async () => {
    const { request, url } = makeRequest(
      "http://localhost/page?_rsc_action=hash%23test",
    );
    const deps = makeDeps();

    const plan = await classifyRequest(request, url, deps);

    expect(plan.mode).toBe("action");
    if (plan.mode === "action") {
      expect(plan.actionId).toBe("hash#test");
    }
  });

  // ---- Loader ----

  it("classifies loader fetch", async () => {
    const { request, url } = makeRequest(
      "http://localhost/page?_rsc_loader=myLoader",
    );
    const deps = makeDeps();

    const plan = await classifyRequest(request, url, deps);

    expect(plan.mode).toBe("loader");
  });

  // ---- Progressive Enhancement ----

  it("classifies PE form submission", async () => {
    const { request, url } = makeRequest("http://localhost/page", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const deps = makeDeps();

    const plan = await classifyRequest(request, url, deps);

    expect(plan.mode).toBe("pe-render");
  });

  it("classifies PE multipart form submission", async () => {
    const { request, url } = makeRequest("http://localhost/page", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=----" },
    });
    const deps = makeDeps();

    const plan = await classifyRequest(request, url, deps);

    expect(plan.mode).toBe("pe-render");
  });

  it("does not classify POST action as PE", async () => {
    const { request, url } = makeRequest("http://localhost/page", {
      method: "POST",
      headers: {
        "rsc-action": "hash#test",
        "content-type": "multipart/form-data; boundary=----",
      },
    });
    const deps = makeDeps();

    const plan = await classifyRequest(request, url, deps);

    expect(plan.mode).toBe("action");
  });

  // ---- Partial render ----

  it("classifies partial navigation", async () => {
    const { request, url } = makeRequest(
      "http://localhost/page?_rsc_partial=1",
    );
    const deps = makeDeps();

    const plan = await classifyRequest(request, url, deps);

    expect(plan.mode).toBe("partial-render");
  });

  it("downgrades to full render on app switch", async () => {
    const { request, url } = makeRequest(
      "http://localhost/page?_rsc_partial=1&_rsc_rid=other-router",
    );
    const deps = makeDeps({ routerId: "test-router" });

    const plan = await classifyRequest(request, url, deps);

    expect(plan.mode).toBe("full-render");
  });

  // ---- Full render ----

  it("classifies full document request", async () => {
    const { request, url } = makeRequest("http://localhost/page");
    const deps = makeDeps();

    const plan = await classifyRequest(request, url, deps);

    expect(plan.mode).toBe("full-render");
  });

  // ---- Route snapshot is always present ----

  it("all plans carry route snapshot with params", async () => {
    mockLoadManifest.mockResolvedValue(makeEntry());
    const { request, url } = makeRequest("http://localhost/blog/hello");
    const deps = makeDeps({
      findMatch: () =>
        makeMatch({ routeKey: "blog", params: { slug: "hello" } }),
    });

    const plan = await classifyRequest(request, url, deps);

    expect(plan.route!.routeKey).toBe("blog");
    expect(plan.route!.params).toEqual({ slug: "hello" });
  });

  // ---- Route middleware is carried ----

  it("carries route middleware on render plans", async () => {
    const mw = [{ handler: vi.fn(), params: {} }];
    mockCollectRouteMiddleware.mockReturnValue(mw);
    mockLoadManifest.mockResolvedValue(makeEntry());
    const { request, url } = makeRequest("http://localhost/page");
    const deps = makeDeps();

    const plan = await classifyRequest(request, url, deps);

    expect(plan.mode).toBe("full-render");
    if (plan.mode === "full-render") {
      expect(plan.route!.routeMiddleware).toBe(mw);
    }
  });

  // ---- Negotiation flag ----

  it("sets negotiated when negotiate variants exist", async () => {
    mockLoadManifest.mockResolvedValue(makeEntry());
    const { request, url } = makeRequest("http://localhost/page");
    const deps = makeDeps({
      findMatch: () =>
        makeMatch({
          negotiateVariants: [
            { routeKey: "page.json", responseType: "application/json" },
          ],
        }),
    });

    const plan = await classifyRequest(request, url, deps);

    if (plan.mode === "full-render") {
      expect(plan.negotiated).toBe(true);
    }
  });

  // ---- Priority order ----

  it("action takes priority over loader", async () => {
    const { request, url } = makeRequest(
      "http://localhost/page?_rsc_action=hash%23test&_rsc_loader=myLoader",
      { headers: { "rsc-action": "hash#test" } },
    );
    const deps = makeDeps();

    const plan = await classifyRequest(request, url, deps);

    expect(plan.mode).toBe("action");
  });

  it("action takes priority over partial", async () => {
    const { request, url } = makeRequest(
      "http://localhost/page?_rsc_partial=1",
      { headers: { "rsc-action": "hash#test" } },
    );
    const deps = makeDeps();

    const plan = await classifyRequest(request, url, deps);

    expect(plan.mode).toBe("action");
  });

  it("version mismatch takes priority over action", async () => {
    const { request, url } = makeRequest("http://localhost/page?_rsc_v=0.9.0", {
      headers: { "rsc-action": "hash#test" },
    });
    const deps = makeDeps({ routerVersion: "1.0.0" });

    const plan = await classifyRequest(request, url, deps);

    expect(plan.mode).toBe("version-mismatch");
  });
});
