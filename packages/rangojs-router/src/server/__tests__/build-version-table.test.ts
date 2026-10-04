/**
 * Which versions a router, and a request, resolve to at run time: the
 * consumer's `version`, the build's table, or the dev stamp, in that order.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installRouterVersionsTable,
  getCacheVersions,
  resolveRouterVersions,
  versionKeyPrefix,
} from "../build-version-table.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../request-context.js";
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

function makeCtx(versions?: { data: string; document: string }) {
  return createRequestContext({
    env: {},
    request: new Request("https://example.com/"),
    url: new URL("https://example.com/"),
    variables: {},
    versions,
  });
}

describe("resolveVersionsFrom, without a consumer version", () => {
  const lookup = (
    table: RouterVersionsTable | undefined,
    routerId: string | undefined,
  ) => resolveVersionsFrom(table, routerId, undefined);

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

  it("uses a consumer-set version for both, over the build table", () => {
    installRouterVersionsTable(TABLE);
    expect(resolveRouterVersions("router-a", "release-7")).toEqual({
      data: "release-7",
      document: "release-7",
    });
  });

  it("treats an empty consumer version as set", () => {
    installRouterVersionsTable(TABLE);
    expect(resolveRouterVersions("router-a", "")).toEqual(uniformVersions(""));
  });
});

describe("getCacheVersions", () => {
  afterEach(() => {
    installRouterVersionsTable(undefined);
    vi.restoreAllMocks();
  });

  it("returns the versions of the router serving the request", () => {
    const ctx = makeCtx({ data: "d1", document: "h1" });
    expect(ctx._versions).toEqual({ data: "d1", document: "h1" });
    expect(runWithRequestContext(ctx, () => getCacheVersions())).toEqual({
      data: "d1",
      document: "h1",
    });
  });

  it("is inherited by a context derived from the request's", () => {
    const ctx = makeCtx({ data: "d1", document: "h1" });
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
    expect(runWithRequestContext(makeCtx(), () => getCacheVersions())).toEqual({
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
    runWithRequestContext(makeCtx(), () => getCacheVersions());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(
      /built outside a request.*whole-build cache version.*not read by a router with its own version/,
    );
  });

  it("does not warn inside a request, or when every router has the same versions", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    installRouterVersionsTable(TABLE);
    runWithRequestContext(makeCtx({ data: "d1", document: "h1" }), () =>
      getCacheVersions(),
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
    runWithRequestContext(makeCtx({ data: "d1", document: "h1" }), fn);

  it("prefixes a key with the serving router's version of that kind", () => {
    expect(inRequest(() => versionKeyPrefix(undefined, "data"))).toBe("v/d1/");
    expect(inRequest(() => versionKeyPrefix(undefined, "document"))).toBe(
      "v/h1/",
    );
  });

  it("uses a store-level version for every versioned kind", () => {
    expect(inRequest(() => versionKeyPrefix("mine", "data"))).toBe("v/mine/");
    expect(inRequest(() => versionKeyPrefix("mine", "document"))).toBe(
      "v/mine/",
    );
  });

  it("gives an unversioned key no prefix, whatever the store's version", () => {
    expect(inRequest(() => versionKeyPrefix(undefined, null))).toBe("");
    expect(inRequest(() => versionKeyPrefix("mine", null))).toBe("");
  });

  it("writes no prefix for an empty version", () => {
    expect(versionKeyPrefix(undefined, "data")).toBe("");
    expect(inRequest(() => versionKeyPrefix("", "data"))).toBe("");
  });
});

describe("resolveVersionsFrom", () => {
  // The build's shell capture and the request handler both go through it, so
  // a shell is stamped with the version the handler will check.
  it("prefers the consumer's version, then the table", () => {
    expect(resolveVersionsFrom(TABLE, "router-a", "release-7")).toEqual(
      uniformVersions("release-7"),
    );
    expect(resolveVersionsFrom(TABLE, "router-a", undefined)).toEqual({
      data: "data-a",
      document: "doc-a",
    });
    expect(resolveVersionsFrom(undefined, "router-a", undefined)).toBe(
      undefined,
    );
  });
});

describe("the rango state value", () => {
  const rotated = (versions?: { data: string; document: string }) => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com/"),
      url: new URL("https://example.com/"),
      variables: {},
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
