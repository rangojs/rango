/**
 * Userland: names that come from a request or from loader data and match an
 * Object.prototype member are ordinary keys (#1109). serveShellRequest serves
 * through the router's real handler.
 *
 * - Route segments: building the route trie used to write a `/__proto__`
 *   route's leaf onto Object.prototype, so every trie node without a route of
 *   its own inherited it: `/blog` rendered the `/__proto__` page instead of a
 *   404.
 * - Fetchable loader params: they become ctx.params, so a request whose
 *   params are not string values, or carry `__proto__`, `constructor` or
 *   `prototype`, is a 400 the loader never sees. Its body is the loaderError
 *   Flight payload `load()` rejects with.
 * - Loader data: a PPR capture copies a bake-lane container that holds a
 *   nested promise; an own `__proto__` key (JSON.parse makes one) used to set
 *   the copy's prototype, which Flight refused to serialize.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { createLoader, createRouter, urls } from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";

const runs = { params: 0 };

const ParamsLoader = createLoader(async (ctx) => {
  runs.params += 1;
  return { q: ctx.params.q ?? "none" };
}, true);

const ProtoKeyLoader = createLoader(async () => {
  const data = JSON.parse('{"__proto__":{"admin":true},"name":"proto-data"}');
  data.later = Promise.resolve("proto-later");
  return data as { name: string; later: Promise<string> };
});

const router = createRouter({}).routes(
  urls(({ path, loader }) => [
    path("/constructor", () => <p>constructor page</p>, { name: "ctor" }),
    path("/toString", () => <p>toString page</p>, { name: "str" }),
    path("/__proto__", () => <p>proto page</p>, { name: "proto" }),
    path("/blog/:id", () => <p>post page</p>, { name: "post" }),
    path("/search", () => <p>search page</p>, { name: "search" }),
    path(
      "/proto-data",
      () => <p>proto data page</p>,
      { name: "protoData", ppr: true },
      () => [loader(ProtoKeyLoader, { ssr: false })],
    ),
  ]),
);

beforeEach(async () => {
  runs.params = 0;
  await resetShellTestState();
});
afterAll(() => {
  // A failing run must not leave the leak behind for the next file.
  for (const o of [Object.prototype, Object, Object.prototype.toString]) {
    delete (o as unknown as Record<string, unknown>).r;
  }
});

describe("routes named like Object.prototype members", () => {
  it.each([
    ["/constructor", "constructor page"],
    ["/toString", "toString page"],
    ["/__proto__", "proto page"],
    ["/blog/1", "post page"],
  ])("%s renders its own route", async (url, text) => {
    const result = await serveShellRequest(router, url);
    expect(result.response.status).toBe(200);
    expect(result.body).toContain(text);
  });

  it.each(["/blog", "/hasOwnProperty", "/valueOf/x"])(
    "%s is a 404",
    async (url) => {
      const result = await serveShellRequest(router, url);
      expect(result.response.status).toBe(404);
      expect(result.body).not.toContain("proto page");
    },
  );
});

describe("fetchable loader params", () => {
  const fetchLoader = (params: string) =>
    serveShellRequest(
      router,
      `/search?_rsc_loader=${encodeURIComponent(ParamsLoader.$$id)}` +
        `&_rsc_loader_params=${encodeURIComponent(params)}`,
      { headers: { accept: "text/x-component" } },
    );

  it("string values reach the loader", async () => {
    const result = await fetchLoader('{"q":"shoes"}');
    expect(result.response.status).toBe(200);
    expect(result.body).toContain('"q":"shoes"');
    expect(runs.params).toBe(1);
  });

  it.each(['{"q":1}', '{"constructor":"x"}', '{"__proto__":{"q":"x"}}'])(
    "%s is a 400 with the error load() rejects with, and the loader never runs",
    async (params) => {
      const result = await fetchLoader(params);
      expect(result.response.status).toBe(400);
      expect(result.response.headers.get("content-type")).toContain(
        "text/x-component",
      );
      expect(result.body).toContain('"loaderError"');
      expect(result.body).toContain(
        "Invalid loader params: expected an object of string values",
      );
      expect(runs.params).toBe(0);
    },
  );
});

describe("loader data with an own __proto__ key and a nested promise", () => {
  it("a ppr route captures and serves it", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const miss = await serveShellRequest(router, "/proto-data", {
        cacheStore,
      });
      expect(miss.response.status).toBe(200);
      expect(miss.shellStatus).toBe("MISS");
      expect(miss.body).toContain("proto data page");
      expect(miss.body).toContain('"name":"proto-data"');

      const hit = await serveShellRequest(router, "/proto-data", {
        cacheStore,
      });
      expect(hit.response.status).toBe(200);
      expect(hit.shellStatus).toBe("HIT");
      expect(hit.body).toContain('"name":"proto-data"');
      expect(hit.body).toContain("proto-later");

      expect(errors.mock.calls.flat().join("\n")).not.toContain(
        "Only plain objects",
      );
    } finally {
      errors.mockRestore();
    }
  });
});
