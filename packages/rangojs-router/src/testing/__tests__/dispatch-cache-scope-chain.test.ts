/**
 * Response-route entries through `dispatch`, the public primitive, under
 * nested cache() scopes:
 * - #975: a `key()` result is namespaced, so a request-derived result can't
 *   name another route's default-keyed entry;
 * - #974: an enclosing `condition()` gates the nested entry, enclosing `tags`
 *   tag it (`updateTag(outer)` evicts it), and an enclosing scope on another
 *   store partitions it by that store's keyGenerator result.
 */
import { describe, it, expect, vi } from "vitest";

function pluginRscMock() {
  return {
    createFromReadableStream: vi.fn(),
    renderToReadableStream: vi.fn(),
    loadServerAction: vi.fn(),
    decodeReply: vi.fn(),
    decodeAction: vi.fn(),
    decodeFormState: vi.fn(),
    createTemporaryReferenceSet: vi.fn(),
  };
}
vi.mock("@vitejs/plugin-rsc/rsc/server", pluginRscMock);
vi.mock("@vitejs/plugin-rsc/rsc/client", pluginRscMock);

import { dispatch, runInRequestContext } from "../index.js";
import { createRouter } from "../../router.js";
import { urls } from "../../urls/urls-function.js";
import { MemorySegmentCacheStore } from "../../cache/memory-segment-store.js";
import { updateTag } from "../../cache/tag-invalidation.js";
import type { RequestContext } from "../../server/request-context.js";

type Router = Parameters<typeof dispatch>[0];

const flushWrites = () => new Promise((r) => setTimeout(r, 0));

function client(router: Router) {
  return async (path: string, headers: Record<string, string> = {}) => {
    const res = await dispatch(router, {
      request: new Request(`http://localhost${path}`, { headers }),
    });
    await flushWrites();
    return res.json();
  };
}

describe("dispatch: response-route cache keys are namespaced (#975)", () => {
  it("a raw key() result can't name another route's default-keyed entry", async () => {
    const store = new MemorySegmentCacheStore();
    const putSpy = vi.spyOn(store, "putResponse");
    const router = createRouter<{}>({ cache: { store } }).routes(
      urls(({ path, cache }) => [
        cache(
          { ttl: 60, key: (ctx) => ctx.request.headers.get("x-k") ?? "" },
          () => [path.json("/api/a", () => ({ from: "a" }), { name: "a" })],
        ),
        cache({ ttl: 60 }, () => [
          path.json("/api/b", () => ({ from: "b" }), { name: "b" }),
        ]),
      ]),
    ) as Router;
    const get = client(router);

    // Unnamespaced, this header named /api/b's entry
    // (`response:json:localhost/api/b`) and /api/b served /api/a's body.
    expect(await get("/api/a", { "x-k": "json:localhost/api/b" })).toEqual({
      from: "a",
    });
    expect(await get("/api/b")).toEqual({ from: "b" });
    expect(putSpy.mock.calls.map(([key]) => key)).toEqual([
      "response:key:json%3Alocalhost%2Fapi%2Fb",
      "response:json:localhost/api/b",
    ]);
  });
});

describe("dispatch: a nested response-route cache() inherits the enclosing scopes (#974)", () => {
  it("an enclosing condition() returning false bypasses the nested entry: no read, no write", async () => {
    const store = new MemorySegmentCacheStore();
    const putSpy = vi.spyOn(store, "putResponse");
    let allow = false;
    let runs = 0;
    const router = createRouter<{}>({ cache: { store } }).routes(
      urls(({ path, cache }) => [
        cache({ condition: () => allow }, () => [
          cache({ ttl: 60 }, () => [
            path.json("/api/gated", () => ({ run: ++runs }), {
              name: "gated",
            }),
          ]),
        ]),
      ]),
    ) as Router;
    const get = client(router);

    expect(await get("/api/gated")).toEqual({ run: 1 });
    expect(await get("/api/gated")).toEqual({ run: 2 });
    expect(putSpy).not.toHaveBeenCalled();

    // Allowed, the nested entry caches as before.
    allow = true;
    expect(await get("/api/gated")).toEqual({ run: 3 });
    expect(await get("/api/gated")).toEqual({ run: 3 });
  });

  it("enclosing tags tag the nested entry: updateTag(outer) evicts it", async () => {
    const store = new MemorySegmentCacheStore();
    let runs = 0;
    const router = createRouter<{}>({ cache: { store } }).routes(
      urls(({ path, cache }) => [
        cache({ tags: ["catalog"] }, () => [
          cache({ ttl: 60, tags: ["prices"] }, () => [
            path.json("/api/prices", () => ({ run: ++runs }), {
              name: "prices",
            }),
          ]),
        ]),
      ]),
    ) as Router;
    const get = client(router);

    expect(await get("/api/prices")).toEqual({ run: 1 });
    expect(await get("/api/prices")).toEqual({ run: 1 });

    await runInRequestContext(() => updateTag("catalog"), {
      cacheStore: store,
    });
    expect(await get("/api/prices")).toEqual({ run: 2 });

    // Its own tag still evicts it.
    await runInRequestContext(() => updateTag("prices"), {
      cacheStore: store,
    });
    expect(await get("/api/prices")).toEqual({ run: 3 });
  });

  it("an enclosing scope on another store partitions the nested entry by its keyGenerator", async () => {
    const appStore = new MemorySegmentCacheStore();
    const localized = new MemorySegmentCacheStore({
      keyGenerator: (ctx: RequestContext, defaultKey: string) =>
        `${defaultKey}|${ctx.request.headers.get("x-locale")}`,
    });
    const nested = new MemorySegmentCacheStore();
    const putSpy = vi.spyOn(nested, "putResponse");
    let runs = 0;
    const router = createRouter<{}>({ cache: { store: appStore } }).routes(
      urls(({ path, cache }) => [
        cache({ store: localized }, () => [
          cache({ store: nested, ttl: 60 }, () => [
            path.json(
              "/api/greeting",
              (ctx: { request: Request }) => ({
                locale: ctx.request.headers.get("x-locale"),
                run: ++runs,
              }),
              { name: "greeting" },
            ),
          ]),
        ]),
      ]),
    ) as Router;
    const get = client(router);

    const en = await get("/api/greeting", { "x-locale": "en" });
    expect(await get("/api/greeting", { "x-locale": "en" })).toEqual(en);
    expect(await get("/api/greeting", { "x-locale": "de" })).toEqual({
      locale: "de",
      run: en.run + 1,
    });
    expect(putSpy.mock.calls.map(([key]) => key)).toEqual([
      "response:response%3Ajson%3Alocalhost%2Fapi%2Fgreeting%7Cen|response%3Ajson%3Alocalhost%2Fapi%2Fgreeting",
      "response:response%3Ajson%3Alocalhost%2Fapi%2Fgreeting%7Cde|response%3Ajson%3Alocalhost%2Fapi%2Fgreeting",
    ]);
  });
});
