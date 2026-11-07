import { describe, it, expect } from "vitest";
import { createHostRouter } from "../router";
import { currentAppBounds } from "../../server/app-bounds-scope";
import { matchPattern, patternPath } from "../pattern-matcher";
import { pathHasPrefix } from "../../app-bounds";
import type { AppBounds } from "../../app-bounds";
import type { Handler, HostRouter } from "../types";

/** A handler that answers with the app bounds it runs under. */
function reportBounds(app: string): Handler {
  return async () => {
    // After an await, as the app's render reads them.
    await Promise.resolve();
    return Response.json({ app, appBounds: currentAppBounds() });
  };
}

async function served(
  router: HostRouter,
  url: string,
  init?: RequestInit,
): Promise<{ app: string; appBounds?: AppBounds }> {
  return (await router.match(new Request(url, init))).json();
}

/** The cloudflare-multi-router shape: two path mounts and a catch-all. */
function pathMounted(): HostRouter {
  const router = createHostRouter({
    hostOverride: { cookieName: "x-rango-host", allowedHosts: ["localhost"] },
  });
  router.host(["*.localhost"]).map(reportBounds("admin"));
  router.host(["localhost/app-a"]).map(reportBounds("app-a"));
  router.host(["localhost/app-b"]).map(reportBounds("app-b"));
  router.host(["localhost"]).map(reportBounds("site"));
  router.fallback().map(reportBounds("fallback"));
  return router;
}

describe("app bounds under createHostRouter", () => {
  it("a path-mounted app owns only its prefix", async () => {
    expect(await served(pathMounted(), "http://localhost/app-a/page")).toEqual({
      app: "app-a",
      appBounds: [[["/app-a", true]]],
    });
    // app-b comes after app-a: app-a's prefix is named as another app's.
    expect(await served(pathMounted(), "http://localhost/app-b")).toEqual({
      app: "app-b",
      appBounds: [
        [
          ["/app-a", false],
          ["/app-b", true],
        ],
      ],
    });
  });

  it("the catch-all app owns every path but the mounts before it", async () => {
    expect(await served(pathMounted(), "http://localhost/about")).toEqual({
      app: "site",
      appBounds: [
        [
          ["/app-a", false],
          ["/app-b", false],
          ["", true],
        ],
      ],
    });
  });

  it("an app that owns every path of its host carries no bounds", async () => {
    expect(await served(pathMounted(), "http://admin.localhost/users")).toEqual(
      { app: "admin" },
    );
  });

  it("follows the hostOverride cookie's host, not the URL's", async () => {
    // The cookie picks admin.localhost on the localhost origin: every path of
    // the origin is the admin app's while the cookie stands.
    expect(
      await served(pathMounted(), "http://localhost/app-a", {
        headers: { cookie: "x-rango-host=admin.localhost" },
      }),
    ).toEqual({ app: "admin" });
  });

  it("matches the host case-insensitively and the path as written", async () => {
    expect(await served(pathMounted(), "http://LOCALHOST/app-a")).toEqual({
      app: "app-a",
      appBounds: [[["/app-a", true]]],
    });
  });

  it("names a path prefix of the same app under each of its patterns", async () => {
    const router = createHostRouter();
    router.host(["shop.test/docs", "shop.test/help"]).map(reportBounds("docs"));
    router.host(["shop.test"]).map(reportBounds("site"));
    router.host(["other.test/x"]).map(reportBounds("other"));
    expect(await served(router, "http://shop.test/help/faq")).toEqual({
      app: "docs",
      appBounds: [
        [
          ["/docs", true],
          ["/help", true],
        ],
      ],
    });
  });

  it("composes the bounds of a nested host router with its parent's", async () => {
    const inner = createHostRouter();
    inner.host(["shop.test/app-a/admin"]).map(reportBounds("inner-admin"));
    inner.host(["shop.test"]).map(reportBounds("inner-main"));
    const outer = createHostRouter();
    outer.host(["shop.test/app-a"]).lazy(async () => ({ default: inner }));
    outer.host(["shop.test"]).map(reportBounds("site"));

    expect(await served(outer, "http://shop.test/app-a/page")).toEqual({
      app: "inner-main",
      appBounds: [
        [["/app-a", true]],
        [
          ["/app-a/admin", false],
          ["", true],
        ],
      ],
    });
  });

  it("runs host middleware inside the bounds and leaves none outside", async () => {
    const router = createHostRouter();
    let seenByMiddleware: unknown;
    router
      .host(["shop.test/app-a"])
      .use(async (_request, _input, next) => {
        seenByMiddleware = currentAppBounds();
        return next();
      })
      .map(reportBounds("app-a"));
    router.host(["shop.test"]).map(reportBounds("site"));

    await served(router, "http://shop.test/app-a");
    expect(seenByMiddleware).toEqual([[["/app-a", true]]]);
    expect(currentAppBounds()).toBeUndefined();
  });

  it("the fallback serving a rejected hostOverride cookie carries no bounds", async () => {
    expect(
      await served(pathMounted(), "http://localhost/app-a", {
        headers: { cookie: "x-rango-host=not allowed" },
      }),
    ).toEqual({ app: "fallback" });
  });
});

describe("the browser's path rule and the host router's", () => {
  it("agree on every pattern path the table can carry", () => {
    const suffixes = [
      "",
      "/",
      "/app-a",
      "/app-a/",
      "/app-a/admin",
      "/APP-A",
      "//",
    ];
    const paths = [
      "/",
      "/app-a",
      "/app-a/",
      "/app-a/x",
      "/app-ab",
      "//x",
      "/APP-A",
    ];
    for (const suffix of suffixes) {
      const pattern = `shop.test${suffix}`;
      // The prefix the table carries for this pattern (host/app-bounds.ts).
      const prefix = patternPath(pattern);
      for (const path of paths) {
        expect([pattern, path, pathHasPrefix(path, prefix)]).toEqual([
          pattern,
          path,
          matchPattern(pattern, "shop.test", path, ["shop", "test"]),
        ]);
      }
    }
  });
});
