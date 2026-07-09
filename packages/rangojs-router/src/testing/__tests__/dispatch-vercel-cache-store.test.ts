/**
 * Consumer dogfood coverage for VercelCacheStore through the public testing
 * primitives. A consumer wires the store via createRouter({ cache: { store } })
 * and exercises it by hitting a cached route; this pins that the store works
 * end-to-end through `dispatch` + a `cache()` segment — not only the white-box
 * unit suite. Mirrors dispatch-cache-no-plugin-rsc.test.ts (MemorySegmentCacheStore)
 * with a faithful in-memory fake of Vercel's getCache() handle, so it needs no
 * @vitejs/plugin-rsc mock and runs in the plain node/vitest unit suite.
 */

import { describe, it, expect } from "vitest";
import { dispatch } from "../dispatch.js";
import { createRouter } from "../../router.js";
import { urls } from "../../urls/urls-function.js";
import {
  VercelCacheStore,
  type VercelRuntimeCache,
} from "../../cache/vercel/vercel-cache-store.js";

/** Minimal in-memory fake of the Vercel Runtime Cache (getCache() handle). */
function makeFakeCache(): {
  cache: VercelRuntimeCache;
  store: Map<string, { value: unknown; expiresAt: number | null }>;
} {
  const store = new Map<string, { value: unknown; expiresAt: number | null }>();
  const cache: VercelRuntimeCache = {
    async get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt != null && Date.now() >= entry.expiresAt) {
        store.delete(key);
        return undefined;
      }
      return JSON.parse(JSON.stringify(entry.value));
    },
    async set(key, value, options) {
      store.set(key, {
        value: JSON.parse(JSON.stringify(value)),
        expiresAt:
          options?.ttl != null ? Date.now() + options.ttl * 1000 : null,
      });
    },
    async delete(key) {
      store.delete(key);
    },
    async expireTag() {
      // Not needed for the read/write path under test.
    },
  };
  return { cache, store };
}

describe("dispatch + VercelCacheStore (consumer dogfood)", () => {
  // Cache WRITES are scheduled via ctx.waitUntil; flush before re-reading.
  const flushWrites = () => new Promise((r) => setTimeout(r, 0));

  it("serves a cached path.json route from the Vercel store on the second hit", async () => {
    const { cache } = makeFakeCache();
    const store = new VercelCacheStore({ cache });
    const router = createRouter<{}>({ cache: { store } }).routes(
      urls(({ path, cache: cacheSeg }) => [
        cacheSeg({ ttl: 600 }, () => [
          path.json("/vc-cached", () => ({ ts: Date.now() + Math.random() }), {
            name: "vc.cached",
          }),
        ]),
      ]),
    ) as Parameters<typeof dispatch>[0];

    const first = await (
      await dispatch(router, { request: "/vc-cached" })
    ).json();
    await flushWrites();
    const second = await (
      await dispatch(router, { request: "/vc-cached" })
    ).json();

    // A HIT returns the byte-identical cached body; a fresh re-run would carry a
    // new ts. Equality proves getResponse() served the value putResponse() wrote.
    expect(second).toEqual(first);
  });

  it("writes a response entry into the Vercel store for a cached route", async () => {
    const { cache } = makeFakeCache();
    const store = new VercelCacheStore({ cache });
    const router = createRouter<{}>({ cache: { store } }).routes(
      urls(({ path, cache: cacheSeg }) => [
        cacheSeg({ ttl: 600 }, () => [
          path.json("/vc-cached2", () => ({ ok: true }), {
            name: "vc.cached2",
          }),
        ]),
      ]),
    ) as Parameters<typeof dispatch>[0];

    await dispatch(router, { request: "/vc-cached2" });
    await flushWrites();

    // Default key: response:{type}: + cacheKeyBase(host, path, searchParams).
    const cached = await store.getResponse(
      "response:json:localhost/vc-cached2",
    );
    expect(cached).not.toBeNull();
    expect(cached?.response.status).toBe(200);
    expect(await cached?.response.json()).toEqual({ ok: true });
  });
});
