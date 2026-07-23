import { describe, it, expect, vi } from "vitest";
import {
  resolveNavigation,
  createNavigationSnapshot,
} from "../navigation-snapshot.js";
import type { RouteMatchResult } from "../pattern-matching.js";

function makeMatch(overrides?: Partial<RouteMatchResult>): RouteMatchResult {
  return {
    entry: {} as any,
    routeKey: "test",
    params: {},
    ...overrides,
  } as RouteMatchResult;
}

function makeRequest(
  urlStr: string,
  headers?: Record<string, string>,
): { request: Request; url: URL } {
  const url = new URL(urlStr);
  const request = new Request(urlStr, {
    headers: new Headers(headers),
  });
  return { request, url };
}

describe("resolveNavigation", () => {
  it("returns null when no previous URL header", async () => {
    const { request, url } = makeRequest("http://localhost/page");

    const result = await resolveNavigation(request, url, "page", {
      findMatch: () => null,
    });

    expect(result).toBeNull();
  });

  it("handles relative previous URL paths (resolved against origin)", async () => {
    // new URL("relative", origin) resolves successfully — not malformed
    const { request, url } = makeRequest("http://localhost/page", {
      "X-RSC-Router-Client-Path": "/some-path",
    });

    const result = await resolveNavigation(request, url, "page", {
      findMatch: () => null,
    });

    expect(result).not.toBeNull();
    expect(result!.prevUrl.pathname).toBe("/some-path");
  });

  it("parses prevUrl from X-RSC-Router-Client-Path", async () => {
    const { request, url } = makeRequest("http://localhost/new", {
      "X-RSC-Router-Client-Path": "/old",
    });

    const result = await resolveNavigation(request, url, "new", {
      findMatch: () => null,
    });

    expect(result).not.toBeNull();
    expect(result!.prevUrl.pathname).toBe("/old");
  });

  it("falls back to Referer when X-RSC-Router-Client-Path is missing", async () => {
    const { request, url } = makeRequest("http://localhost/new", {
      Referer: "http://localhost/referer-page",
    });

    const result = await resolveNavigation(request, url, "new", {
      findMatch: () => null,
    });

    expect(result).not.toBeNull();
    expect(result!.prevUrl.pathname).toBe("/referer-page");
  });

  it("matches previous route", async () => {
    const prevMatch = makeMatch({ routeKey: "old", params: { id: "1" } });
    const { request, url } = makeRequest("http://localhost/new", {
      "X-RSC-Router-Client-Path": "/old/1",
    });

    const result = await resolveNavigation(request, url, "new", {
      findMatch: (pathname) => (pathname === "/old/1" ? prevMatch : null),
    });

    expect(result!.prevMatch).toBe(prevMatch);
    expect(result!.prevParams).toEqual({ id: "1" });
  });

  it("sets prevParams to empty object when no prevMatch", async () => {
    const { request, url } = makeRequest("http://localhost/new", {
      "X-RSC-Router-Client-Path": "/unknown",
    });

    const result = await resolveNavigation(request, url, "new", {
      findMatch: () => null,
    });

    expect(result!.prevParams).toEqual({});
  });

  it("parses intercept source URL", async () => {
    const sourceMatch = makeMatch({ routeKey: "source" });
    const { request, url } = makeRequest("http://localhost/target", {
      "X-RSC-Router-Client-Path": "/prev",
      "X-RSC-Router-Intercept-Source": "/source",
    });

    const result = await resolveNavigation(request, url, "target", {
      findMatch: (pathname) => {
        if (pathname === "/source") return sourceMatch;
        return makeMatch({ routeKey: "prev" });
      },
    });

    expect(result!.interceptContextUrl.pathname).toBe("/source");
    expect(result!.interceptContextMatch).toBe(sourceMatch);
    expect(result!.hasInterceptSource).toBe(true);
  });

  it("uses prevUrl as interceptContextUrl when no intercept source", async () => {
    const prevMatch = makeMatch({ routeKey: "prev" });
    const { request, url } = makeRequest("http://localhost/target", {
      "X-RSC-Router-Client-Path": "/prev",
    });

    const result = await resolveNavigation(request, url, "target", {
      findMatch: () => prevMatch,
    });

    expect(result!.interceptContextUrl.pathname).toBe("/prev");
    expect(result!.interceptContextMatch).toBe(prevMatch);
    expect(result!.hasInterceptSource).toBe(false);
  });

  it("resolves relative intercept source URL against origin", async () => {
    // new URL("relative", origin) resolves successfully — treated as a path
    const prevMatch = makeMatch({ routeKey: "prev" });
    const { request, url } = makeRequest("http://localhost/target", {
      "X-RSC-Router-Client-Path": "/prev",
      "X-RSC-Router-Intercept-Source": "/source-page",
    });

    const result = await resolveNavigation(request, url, "target", {
      findMatch: (pathname) => {
        if (pathname === "/source-page")
          return makeMatch({ routeKey: "source" });
        return prevMatch;
      },
    });

    expect(result!.interceptContextUrl.pathname).toBe("/source-page");
    expect(result!.interceptContextMatch!.routeKey).toBe("source");
    expect(result!.hasInterceptSource).toBe(true);
  });

  it("detects same-route navigation", async () => {
    const match = makeMatch({ routeKey: "detail" });
    const { request, url } = makeRequest("http://localhost/detail/2", {
      "X-RSC-Router-Client-Path": "/detail/1",
    });

    const result = await resolveNavigation(request, url, "detail", {
      findMatch: () => match,
    });

    expect(result!.isSameRouteNavigation).toBe(true);
  });

  it("detects different-route navigation", async () => {
    const prevMatch = makeMatch({ routeKey: "list" });
    const { request, url } = makeRequest("http://localhost/detail/1", {
      "X-RSC-Router-Client-Path": "/list",
    });

    const result = await resolveNavigation(request, url, "detail", {
      findMatch: () => prevMatch,
    });

    expect(result!.isSameRouteNavigation).toBe(false);
  });

  it("isSameRouteNavigation is false when interceptContextMatch is null", async () => {
    const { request, url } = makeRequest("http://localhost/detail/1", {
      "X-RSC-Router-Client-Path": "/unknown",
    });

    const result = await resolveNavigation(request, url, "detail", {
      findMatch: () => null,
    });

    expect(result!.isSameRouteNavigation).toBe(false);
  });

  it("sets effectiveFromUrl to intercept source when present", async () => {
    const { request, url } = makeRequest("http://localhost/target", {
      "X-RSC-Router-Client-Path": "/prev",
      "X-RSC-Router-Intercept-Source": "/source",
    });

    const result = await resolveNavigation(request, url, "target", {
      findMatch: () => makeMatch(),
    });

    expect(result!.effectiveFromUrl.pathname).toBe("/source");
  });

  it("sets effectiveFromUrl to prevUrl when no intercept source", async () => {
    const { request, url } = makeRequest("http://localhost/target", {
      "X-RSC-Router-Client-Path": "/prev",
    });

    const result = await resolveNavigation(request, url, "target", {
      findMatch: () => makeMatch(),
    });

    expect(result!.effectiveFromUrl.pathname).toBe("/prev");
  });

  it("parses clientSegmentIds from query param", async () => {
    const { request, url } = makeRequest(
      "http://localhost/page?_rsc_segments=L0,R1,L2&_rsc_partial=1",
      { "X-RSC-Router-Client-Path": "/prev" },
    );

    const result = await resolveNavigation(request, url, "page", {
      findMatch: () => makeMatch(),
    });

    expect(result!.clientSegmentIds).toEqual(["L0", "R1", "L2"]);
    expect(result!.clientSegmentSet).toEqual(new Set(["L0", "R1", "L2"]));
  });

  it("handles empty segments param", async () => {
    const { request, url } = makeRequest("http://localhost/page", {
      "X-RSC-Router-Client-Path": "/prev",
    });

    const result = await resolveNavigation(request, url, "page", {
      findMatch: () => makeMatch(),
    });

    expect(result!.clientSegmentIds).toEqual([]);
    expect(result!.clientSegmentSet.size).toBe(0);
  });

  it("filters out parallel segment IDs (.@)", async () => {
    const { request, url } = makeRequest(
      "http://localhost/page?_rsc_segments=L0,L0R1L0.@sidebar,R1",
      { "X-RSC-Router-Client-Path": "/prev" },
    );

    const result = await resolveNavigation(request, url, "page", {
      findMatch: () => makeMatch(),
    });

    expect(result!.filteredSegmentIds).toEqual(["L0", "R1"]);
  });

  it("filters out loader segment IDs (D\\d+.)", async () => {
    const { request, url } = makeRequest(
      "http://localhost/page?_rsc_segments=L0,L0D0.cart,R1,R1D1.user",
      { "X-RSC-Router-Client-Path": "/prev" },
    );

    const result = await resolveNavigation(request, url, "page", {
      findMatch: () => makeMatch(),
    });

    expect(result!.filteredSegmentIds).toEqual(["L0", "R1"]);
  });

  it("parses stale flag", async () => {
    const { request, url } = makeRequest(
      "http://localhost/page?_rsc_stale=true",
      { "X-RSC-Router-Client-Path": "/prev" },
    );

    const result = await resolveNavigation(request, url, "page", {
      findMatch: () => makeMatch(),
    });

    expect(result!.stale).toBe(true);
  });

  it("stale defaults to false", async () => {
    const { request, url } = makeRequest("http://localhost/page", {
      "X-RSC-Router-Client-Path": "/prev",
    });

    const result = await resolveNavigation(request, url, "page", {
      findMatch: () => makeMatch(),
    });

    expect(result!.stale).toBe(false);
  });

  it("detects HMR header", async () => {
    const { request, url } = makeRequest("http://localhost/page", {
      "X-RSC-Router-Client-Path": "/prev",
      "X-RSC-HMR": "1",
    });

    const result = await resolveNavigation(request, url, "page", {
      findMatch: () => makeMatch(),
    });

    expect(result!.isHmr).toBe(true);
  });

  it("isHmr defaults to false", async () => {
    const { request, url } = makeRequest("http://localhost/page", {
      "X-RSC-Router-Client-Path": "/prev",
    });

    const result = await resolveNavigation(request, url, "page", {
      findMatch: () => makeMatch(),
    });

    expect(result!.isHmr).toBe(false);
  });
});

describe("createNavigationSnapshot", () => {
  it("creates snapshot with default values", async () => {
    const snapshot = createNavigationSnapshot();
    expect(snapshot.prevUrl.pathname).toBe("/");
    expect(snapshot.prevParams).toEqual({});
    expect(snapshot.prevMatch).toBeNull();
    expect(snapshot.clientSegmentIds).toEqual([]);
    expect(snapshot.stale).toBe(false);
    expect(snapshot.isSameRouteNavigation).toBe(false);
    expect(snapshot.hasInterceptSource).toBe(false);
    expect(snapshot.isHmr).toBe(false);
  });

  it("merges overrides", async () => {
    const prevUrl = new URL("http://localhost/old");
    const snapshot = createNavigationSnapshot({
      prevUrl,
      stale: true,
      isSameRouteNavigation: true,
    });
    expect(snapshot.prevUrl).toBe(prevUrl);
    expect(snapshot.stale).toBe(true);
    expect(snapshot.isSameRouteNavigation).toBe(true);
  });
});
