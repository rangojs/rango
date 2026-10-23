/**
 * Which versions a router, and a request, resolve to at run time: the
 * build's table or the dev stamp, in that order.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installRouterVersionsTable,
  getCacheVersions,
  resolveRouterVersions,
  versionKeyPrefix,
} from "../build-version-table.js";
import { runWithRequestContext } from "../request-context.js";
import { makeRequestContext } from "../../__tests__/kit/request-context.js";
import {
  resolveVersionsFrom,
  uniformVersions,
  type RouterVersionsTable,
} from "../../router-versions.js";

const TABLE: RouterVersionsTable = {
  "router-a": ["data-a", "doc-a"],
  "router-b": ["data-b", "doc-b"],
  "*": ["data-all", "doc-all"],
};

const EXAMPLE_URL = "https://example.com/";

describe("resolveVersionsFrom", () => {
  const lookup = (
    table: RouterVersionsTable | undefined,
    routerId: string | undefined,
  ) => resolveVersionsFrom(table, routerId);

  it("returns the router's own pair", () => {
    expect(lookup(TABLE, "router-a")).toEqual({
      data: "data-a",
      document: "doc-a",
    });
  });

  it("falls back to the whole-build pair for a router the build did not list", () => {
    expect(lookup(TABLE, "router_0")).toEqual({
      data: "data-all",
      document: "doc-all",
    });
    expect(lookup(TABLE, undefined)).toEqual({
      data: "data-all",
      document: "doc-all",
    });
  });

  it("does not read inherited object keys as router ids", () => {
    expect(lookup(TABLE, "constructor")).toEqual({
      data: "data-all",
      document: "doc-all",
    });
  });

  it("returns undefined without a table", () => {
    expect(lookup(undefined, "router-a")).toBeUndefined();
    expect(lookup({}, "router-a")).toBeUndefined();
  });
});

describe("resolveRouterVersions", () => {
  afterEach(() => installRouterVersionsTable(undefined));

  it("uses the dev stamp for both when there is no build table", () => {
    // The test alias stubs VERSION as "" (src/__mocks__/version.ts).
    expect(resolveRouterVersions("router-a")).toEqual(uniformVersions(""));
  });

  it("uses the build's pair for the router", () => {
    installRouterVersionsTable(TABLE);
    expect(resolveRouterVersions("router-b")).toEqual({
      data: "data-b",
      document: "doc-b",
    });
  });
});

describe("getCacheVersions", () => {
  afterEach(() => {
    installRouterVersionsTable(undefined);
    vi.restoreAllMocks();
  });

  it("returns the versions of the router serving the request", () => {
    const ctx = makeRequestContext({
      url: EXAMPLE_URL,
      versions: { data: "d1", document: "h1" },
    });
    expect(ctx._versions).toEqual({ data: "d1", document: "h1" });
    expect(runWithRequestContext(ctx, () => getCacheVersions())).toEqual({
      data: "d1",
      document: "h1",
    });
  });

  it("is inherited by a context derived from the request's", () => {
    const ctx = makeRequestContext({
      url: EXAMPLE_URL,
      versions: { data: "d1", document: "h1" },
    });
    const derived = Object.create(ctx) as typeof ctx;
    expect(runWithRequestContext(derived, () => getCacheVersions())).toEqual({
      data: "d1",
      document: "h1",
    });
  });

  it("falls back to the whole-build pair outside a request", () => {
    installRouterVersionsTable(TABLE);
    expect(getCacheVersions()).toEqual({
      data: "data-all",
      document: "doc-all",
    });
  });

  it("falls back to the whole-build pair on a context no router created", () => {
    installRouterVersionsTable(TABLE);
    expect(
      runWithRequestContext(makeRequestContext({ url: EXAMPLE_URL }), () =>
        getCacheVersions(),
      ),
    ).toEqual({
      data: "data-all",
      document: "doc-all",
    });
  });

  it("resolves the whole-build pair again after the table is swapped", () => {
    installRouterVersionsTable(TABLE);
    expect(getCacheVersions().data).toBe("data-all");
    installRouterVersionsTable({ "*": ["d2", "h2"] });
    expect(getCacheVersions()).toEqual({ data: "d2", document: "h2" });
  });

  // A write keyed with the whole-build pair is one no router with its own
  // version reads back. The log line is how a production deploy shows it.
  it("warns once per process when it falls back while routers have their own versions", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    installRouterVersionsTable(TABLE);
    getCacheVersions();
    getCacheVersions();
    runWithRequestContext(makeRequestContext({ url: EXAMPLE_URL }), () =>
      getCacheVersions(),
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(
      /built outside a request.*whole-build cache version.*not read by a router with its own version/,
    );
  });

  it("does not warn inside a request, or when every router has the same versions", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    installRouterVersionsTable(TABLE);
    runWithRequestContext(
      makeRequestContext({
        url: EXAMPLE_URL,
        versions: { data: "d1", document: "h1" },
      }),
      () => getCacheVersions(),
    );
    installRouterVersionsTable({ "*": ["d", "h"], "router-a": ["d", "h"] });
    getCacheVersions();
    installRouterVersionsTable(undefined);
    getCacheVersions();
    expect(warn).not.toHaveBeenCalled();
  });

  it("is public from @rangojs/router/cache, for a custom store", async () => {
    const cache = await import("../../cache/index.js");
    expect(cache.getCacheVersions).toBe(getCacheVersions);
  });
});

describe("versionKeyPrefix", () => {
  afterEach(() => installRouterVersionsTable(undefined));
  const inRequest = <T>(fn: () => T): T =>
    runWithRequestContext(
      makeRequestContext({
        url: EXAMPLE_URL,
        versions: { data: "d1", document: "h1" },
      }),
      fn,
    );

  it("prefixes a key with the serving router's version of that kind", () => {
    expect(inRequest(() => versionKeyPrefix("data"))).toBe("v/d1/");
    expect(inRequest(() => versionKeyPrefix("document"))).toBe("v/h1/");
  });

  it("gives an unversioned key no prefix", () => {
    expect(inRequest(() => versionKeyPrefix(null))).toBe("");
  });

  it("writes no prefix for an empty version", () => {
    expect(versionKeyPrefix("data")).toBe("");
  });
});

describe("the rango state value", () => {
  const rotated = (versions?: { data: string; document: string }) => {
    const ctx = makeRequestContext({
      url: EXAMPLE_URL,
      stateCookieName: "rango-state_r",
      versions,
    });
    ctx._rotateStateCookie();
    return ctx.res.headers.getSetCookie()[0]!;
  };

  // The browser keeps its state value only while its prefix equals the
  // payload's metadata.version, which is the document version.
  it("is prefixed with the document version, not the data version", () => {
    const cookie = rotated({ data: "data-a", document: "doc-a" });
    expect(cookie).toMatch(/^rango-state_r=doc-a:\d+/);
    expect(cookie).not.toContain("data-a");
  });

  it("keeps the `0` prefix on a context without versions", () => {
    expect(rotated()).toMatch(/^rango-state_r=0:\d+/);
  });
});
