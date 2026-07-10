/**
 * P2b regression: the dispatch response-route cache path must be usable from a
 * plain node/vitest consumer test that does NOT mock @vitejs/plugin-rsc.
 *
 * dispatch lazily `import("../cache/cache-scope.js")` for the cached response
 * route. cache-scope used to EAGERLY pull `./segment-codec.js` (directly, and
 * transitively via handle-snapshot.js), which imports @vitejs/plugin-rsc/rsc — a
 * `virtual:` module the default ESM loader cannot resolve. So hitting a cached
 * response route via dispatch crashed with "Only URLs with a scheme in: file,
 * data, and node are supported ... Received protocol 'virtual:'", unless the
 * consumer mocked plugin-rsc (which the sibling dispatch.test.ts does).
 *
 * The fix makes cache-scope plugin-rsc-free at module load by deferring both
 * segment-codec uses (and handle-snapshot's) to lazy dynamic imports inside the
 * async methods. This file deliberately omits the vi.mock so it pins the
 * module-load contract: requiring cache-scope (and dispatching a cached route)
 * must not touch plugin-rsc on the eager graph.
 */

import { describe, it, expect } from "vitest";
import { dispatch } from "../dispatch.js";
import { createRouter } from "../../router.js";
import { urls } from "../../urls/urls-function.js";
import { MemorySegmentCacheStore } from "../../cache/memory-segment-store.js";

describe("dispatch cached response route (no plugin-rsc mock)", () => {
  // The cache WRITE is scheduled via ctx.waitUntil; flush before re-reading.
  const flushWrites = () => new Promise((r) => setTimeout(r, 0));

  it("serves a cached path.json route without a virtual: import error", async () => {
    const store = new MemorySegmentCacheStore();
    const router = createRouter<{}>({ cache: { store } }).routes(
      urls(({ path, cache }) => [
        cache({ ttl: 600 }, () => [
          path.json(
            "/cached-nomock",
            () => ({ ts: Date.now() + Math.random() }),
            {
              name: "cached.nomock",
            },
          ),
        ]),
      ]),
    ) as Parameters<typeof dispatch>[0];

    const first = await (
      await dispatch(router, { request: "/cached-nomock" })
    ).json();
    await flushWrites();
    const second = await (
      await dispatch(router, { request: "/cached-nomock" })
    ).json();

    // A HIT returns the byte-identical cached body; a fresh re-run would carry a
    // new ts. Reaching this assertion at all proves the lazy import resolved
    // (before the fix the dispatch above threw on the virtual: import).
    expect(second).toEqual(first);
  });

  it("writes an entry into the store for a cached response route", async () => {
    const store = new MemorySegmentCacheStore();
    const router = createRouter<{}>({ cache: { store } }).routes(
      urls(({ path, cache }) => [
        cache({ ttl: 600 }, () => [
          path.json("/cached-nomock2", () => ({ ok: true }), {
            name: "cached.nomock2",
          }),
        ]),
      ]),
    ) as Parameters<typeof dispatch>[0];

    await dispatch(router, { request: "/cached-nomock2" });
    await flushWrites();

    // Default key: response:{type}: + cacheKeyBase(host, path, searchParams).
    const cached = await store.getResponse(
      "response:json:localhost/cached-nomock2",
    );
    expect(cached).not.toBeNull();
    expect(cached?.response.status).toBe(200);
  });
});
