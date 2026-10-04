/**
 * What a consumer can observe of the per-router cache versions, through the
 * public testing primitives: `setBuildVersions` simulates a build's versions,
 * `serveShellRequest` serves through the production request handler with a
 * store that outlives the "deploys" (a VercelCacheStore over one fake cache
 * handle).
 *
 * The rules (docs/design/per-app-cache-version.md):
 * - cached data follows the data version, stored HTML the document version;
 * - the browser's `_rsc_v` is compared with the document version;
 * - a consumer-set `version` is used for both and nothing overrides it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import { resetShellTestState, serveShellRequest } from "../flight.entry.js";
import { setBuildVersions } from "../index.js";
import { createRouter, urls } from "../../index.rsc.js";
import {
  VercelCacheStore,
  type VercelRuntimeCache,
} from "../../cache/index.js";

/** One platform cache for every "deploy" of a test. */
function makeRuntimeCache(): VercelRuntimeCache {
  const values = new Map<string, unknown>();
  return {
    async get(key) {
      const value = values.get(key);
      return value === undefined ? undefined : structuredClone(value);
    },
    async set(key, value) {
      values.set(key, structuredClone(value));
    },
    async delete(key) {
      values.delete(key);
    },
    async expireTag() {},
  };
}

/** Handler runs, to tell a segment-cache hit (no run) from a render. */
const runs = { cached: 0, product: 0 };

function makeRouter(options: { version?: string; id?: string } = {}) {
  return createRouter(options).routes(
    urls(({ path, cache }) => [
      path(
        "/product",
        () => {
          runs.product += 1;
          return <h1>{`product-run-${runs.product}`}</h1>;
        },
        { name: "product", ppr: true },
      ),
      cache({ ttl: 300 }, () => [
        path(
          "/cached",
          () => {
            runs.cached += 1;
            return <p>{`cached-run-${runs.cached}`}</p>;
          },
          { name: "cached" },
        ),
      ]),
      path("/plain", () => <p>plain</p>, { name: "plain" }),
    ]),
  );
}

function metadataVersion(flight: string | undefined): unknown {
  const row = flight?.split("\n").find((line) => line.startsWith("0:"));
  expect(row).toBeDefined();
  return (JSON.parse(row!.slice(2)) as { metadata: { version?: unknown } })
    .metadata.version;
}

describe("per-router cache versions through the testing primitives", () => {
  let cache: VercelRuntimeCache;
  const serve = (
    router: ReturnType<typeof makeRouter>,
    url: string,
    extra: Parameters<typeof serveShellRequest>[2] = {},
  ) =>
    serveShellRequest(router, url, {
      // A store per request over the one cache, as a cache factory builds it.
      cacheStore: new VercelCacheStore({ cache }),
      ...extra,
    });

  beforeEach(async () => {
    await resetShellTestState();
    cache = makeRuntimeCache();
    runs.cached = 0;
    runs.product = 0;
  });

  afterEach(() => setBuildVersions());

  describe("stored HTML (a PPR shell) follows the document version", () => {
    it("is served again by a deploy with the same versions", async () => {
      const router = makeRouter();
      setBuildVersions({ data: "d1", document: "h1" });
      expect((await serve(router, "/product")).shellStatus).toBe("MISS");
      expect((await serve(router, "/product")).shellStatus).toBe("HIT");

      // A rebuild of unchanged code: the same versions, a new process.
      setBuildVersions({ data: "d1", document: "h1" });
      await resetShellTestState();
      expect((await serve(router, "/product")).shellStatus).toBe("HIT");
    });

    it("is not served after the document version changed", async () => {
      const router = makeRouter();
      setBuildVersions({ data: "d1", document: "h1" });
      await serve(router, "/product");
      expect((await serve(router, "/product")).shellStatus).toBe("HIT");

      // A client-only deploy: same data version, new document version.
      setBuildVersions({ data: "d1", document: "h2" });
      await resetShellTestState();
      expect((await serve(router, "/product")).shellStatus).toBe("MISS");
    });
  });

  describe("cached data (a cache() entry) follows the data version", () => {
    it("survives a deploy that only changes the document version", async () => {
      const router = makeRouter();
      setBuildVersions({ data: "d1", document: "h1" });
      expect((await serve(router, "/cached")).body).toContain("cached-run-1");
      expect((await serve(router, "/cached")).body).toContain("cached-run-1");

      setBuildVersions({ data: "d1", document: "h2" });
      expect((await serve(router, "/cached")).body).toContain("cached-run-1");
      expect(runs.cached).toBe(1);
    });

    it("is not served after the data version changed", async () => {
      const router = makeRouter();
      setBuildVersions({ data: "d1", document: "h1" });
      await serve(router, "/cached");
      setBuildVersions({ data: "d2", document: "h2" });
      expect((await serve(router, "/cached")).body).toContain("cached-run-2");
    });

    it("is unversioned without a build, as tests have always run", async () => {
      const router = makeRouter();
      await serve(router, "/cached");
      expect((await serve(router, "/cached")).body).toContain("cached-run-1");
    });
  });

  describe("per router", () => {
    it("serves each router with its own versions from the table", async () => {
      const a = makeRouter({ id: "app-a" });
      const b = makeRouter({ id: "app-b" });
      setBuildVersions({
        data: "whole",
        document: "whole",
        routers: {
          "app-a": { data: "dA", document: "hA" },
          "app-b": { data: "dB", document: "hB" },
        },
      });
      expect(
        metadataVersion((await serve(a, "/plain", { partial: true })).flight),
      ).toBe("hA");
      expect(
        metadataVersion((await serve(b, "/plain", { partial: true })).flight),
      ).toBe("hB");

      // The same path under two routers does not share an entry.
      await serve(a, "/cached");
      expect((await serve(b, "/cached")).body).toContain("cached-run-2");
      expect((await serve(a, "/cached")).body).toContain("cached-run-1");
    });

    it("keeps one router's cache when a deploy changes only the other", async () => {
      const a = makeRouter({ id: "app-a" });
      const b = makeRouter({ id: "app-b" });
      const deploy = (dataA: string) =>
        setBuildVersions({
          data: "whole",
          document: "whole",
          routers: {
            "app-a": { data: dataA, document: `h-${dataA}` },
            "app-b": { data: "dB", document: "hB" },
          },
        });
      deploy("dA1");
      await serve(a, "/cached"); // cached-run-1
      await serve(b, "/cached"); // cached-run-2
      deploy("dA2");
      expect((await serve(b, "/cached")).body).toContain("cached-run-2");
      expect((await serve(a, "/cached")).body).toContain("cached-run-3");
    });

    it("gives a router the build did not list the whole-build versions", async () => {
      const router = makeRouter({ id: "unlisted" });
      setBuildVersions({
        data: "whole-d",
        document: "whole-h",
        routers: { other: { data: "x", document: "y" } },
      });
      expect(
        metadataVersion(
          (await serve(router, "/plain", { partial: true })).flight,
        ),
      ).toBe("whole-h");
    });
  });

  describe("the reload check", () => {
    it("sends the document version to the browser", async () => {
      const router = makeRouter();
      setBuildVersions({ data: "d1", document: "h1" });
      const result = await serve(router, "/plain", { partial: true });
      expect(metadataVersion(result.flight)).toBe("h1");
    });

    it("answers a tab on another document version with a reload", async () => {
      const router = makeRouter();
      setBuildVersions({ data: "d1", document: "h2" });
      const stale = await serve(router, "/plain?_rsc_v=h1", { partial: true });
      expect(stale.response.headers.get("X-RSC-Reload")).toContain("/plain");
      expect(stale.body).toBe("");
    });

    it("does not reload a tab on the same document version", async () => {
      const router = makeRouter();
      // The data version changed and the document version did not: this
      // cannot come out of a build (the document version covers the data
      // version), and it shows which of the two the check reads.
      setBuildVersions({ data: "d2", document: "h1" });
      const current = await serve(router, "/plain?_rsc_v=h1", {
        partial: true,
      });
      expect(current.response.headers.get("X-RSC-Reload")).toBeNull();
      expect(metadataVersion(current.flight)).toBe("h1");
    });

    // A request handler resolves its router's versions once. serveShellRequest
    // keeps a handler per router and store, so a deploy must not be answered
    // by the handler the previous deploy created.
    it("answers with the new deploy's version from the same router and store", async () => {
      const router = makeRouter();
      const cacheStore = new VercelCacheStore({ cache });
      const version = async () =>
        metadataVersion(
          (
            await serveShellRequest(router, "/plain", {
              cacheStore,
              partial: true,
            })
          ).flight,
        );
      setBuildVersions({ data: "d1", document: "h1" });
      expect(await version()).toBe("h1");
      setBuildVersions({ data: "d1", document: "h2" });
      expect(await version()).toBe("h2");
    });
  });

  describe("a consumer-set version", () => {
    it("is used for both versions, whatever the build computed", async () => {
      const router = makeRouter({ version: "release-7" });
      setBuildVersions({ data: "d1", document: "h1" });
      expect(
        metadataVersion(
          (await serve(router, "/plain", { partial: true })).flight,
        ),
      ).toBe("release-7");
      expect((await serve(router, "/product")).shellStatus).toBe("MISS");
      await serve(router, "/cached");

      // A deploy that changes every build version changes nothing here.
      setBuildVersions({ data: "d2", document: "h2" });
      await resetShellTestState();
      expect((await serve(router, "/product")).shellStatus).toBe("HIT");
      expect((await serve(router, "/cached")).body).toContain("cached-run-1");
    });

    it("clears the cache when the consumer changes it", async () => {
      setBuildVersions({ data: "d1", document: "h1" });
      await serve(makeRouter({ version: "release-7" }), "/cached");
      expect(
        (await serve(makeRouter({ version: "release-8" }), "/cached")).body,
      ).toContain("cached-run-2");
    });
  });
});
