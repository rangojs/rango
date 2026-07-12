import { describe, it, expect, vi } from "vitest";

// createRouter's match path transitively imports @vitejs/plugin-rsc/rsc, whose
// top-level body imports Vite virtual modules that do not resolve in plain
// node/vitest. dispatch() itself never renders RSC, so a stub is sufficient.
vi.mock("@vitejs/plugin-rsc/rsc", () => ({
  createFromReadableStream: vi.fn(),
  renderToReadableStream: vi.fn(),
  loadServerAction: vi.fn(),
  decodeReply: vi.fn(),
  decodeAction: vi.fn(),
  decodeFormState: vi.fn(),
  createTemporaryReferenceSet: vi.fn(),
}));

import { dispatch } from "../dispatch.js";
import { createRouter } from "../../router.js";
import { urls } from "../../urls/urls-function.js";
import { MemorySegmentCacheStore } from "../../cache/memory-segment-store.js";
import { TRACKING_SEARCH_PARAMS } from "../../cache/search-params-filter.js";
import type { CacheSearchParams } from "../../cache/search-params-filter.js";

/**
 * Userland coverage for `createRouter({ cache: { searchParams } })` through
 * the public dispatch primitive: excluded params must collapse cache slots
 * (byte-identical HIT), surviving params must keep distinct slots, and
 * handlers must still see the full query string (cache-key-only semantics).
 */
describe("cache.searchParams key filtering (dispatch)", () => {
  // The cache WRITE is scheduled via ctx.waitUntil (a microtask without an
  // executionContext); flush the queue so the second dispatch can observe it.
  const flushWrites = () => new Promise((r) => setTimeout(r, 0));

  function buildRouter(
    store: MemorySegmentCacheStore,
    searchParams?: CacheSearchParams,
  ) {
    return createRouter<{}>({ cache: { store, searchParams } }).routes(
      urls(({ path, cache }) => [
        cache({ ttl: 600 }, () => [
          path.json(
            "/tracked",
            (ctx: { searchParams: URLSearchParams }) => ({
              seen: ctx.searchParams.get("utm_source"),
              nonce: Math.random(),
            }),
            { name: "tracked.json" },
          ),
        ]),
      ]),
    ) as Parameters<typeof dispatch>[0];
  }

  it("collapses excluded-param variants onto one cache slot (HIT across utm variants)", async () => {
    const store = new MemorySegmentCacheStore();
    const router = buildRouter(store, {
      exclude: [...TRACKING_SEARCH_PARAMS],
    });

    const first = await (
      await dispatch(router, { request: "/tracked?utm_source=tw" })
    ).json();
    await flushWrites();
    const second = await (
      await dispatch(router, { request: "/tracked?utm_source=ig" })
    ).json();

    // Byte-identical cached body: the second request is a HIT on the slot the
    // first wrote -- including the FIRST request's utm value, which is exactly
    // the documented contract (key-only filtering; exclusion promises the
    // output does not depend on the param).
    expect(second).toEqual(first);
    expect(second.seen).toBe("tw");

    // The stored key carries no search suffix: excluded-only URLs share the
    // bare-path slot.
    const cached = await store.getResponse("response:json:localhost/tracked");
    expect(cached).not.toBeNull();
  });

  it("handlers still see the full query string on a MISS (cache-key-only scope)", async () => {
    const store = new MemorySegmentCacheStore();
    const router = buildRouter(store, { exclude: ["utm_*"] });

    const body = await (
      await dispatch(router, { request: "/tracked?utm_source=tw" })
    ).json();
    expect(body.seen).toBe("tw");
  });

  it("a non-excluded param still keys a distinct slot", async () => {
    const store = new MemorySegmentCacheStore();
    const router = buildRouter(store, { exclude: ["utm_*"] });

    const first = await (
      await dispatch(router, { request: "/tracked?page=1" })
    ).json();
    await flushWrites();
    const second = await (
      await dispatch(router, { request: "/tracked?page=2" })
    ).json();

    expect(second.nonce).not.toBe(first.nonce);
  });

  it("include mode: only allowlisted params key the cache", async () => {
    const store = new MemorySegmentCacheStore();
    const router = buildRouter(store, { include: ["q"] });

    const first = await (
      await dispatch(router, { request: "/tracked?q=a&sort=asc" })
    ).json();
    await flushWrites();
    const sameQ = await (
      await dispatch(router, { request: "/tracked?q=a&sort=desc" })
    ).json();
    const otherQ = await (
      await dispatch(router, { request: "/tracked?q=b&sort=asc" })
    ).json();

    expect(sameQ).toEqual(first);
    expect(otherQ.nonce).not.toBe(first.nonce);
  });

  it("'none': every query variant shares the bare-path slot", async () => {
    const store = new MemorySegmentCacheStore();
    const router = buildRouter(store, "none");

    const first = await (
      await dispatch(router, { request: "/tracked?a=1" })
    ).json();
    await flushWrites();
    const second = await (
      await dispatch(router, { request: "/tracked?b=2&c=3" })
    ).json();

    expect(second).toEqual(first);
  });

  it("default (no searchParams config): variants stay distinct slots", async () => {
    const store = new MemorySegmentCacheStore();
    const router = buildRouter(store);

    const first = await (
      await dispatch(router, { request: "/tracked?utm_source=tw" })
    ).json();
    await flushWrites();
    const second = await (
      await dispatch(router, { request: "/tracked?utm_source=ig" })
    ).json();

    expect(second.nonce).not.toBe(first.nonce);
    expect(second.seen).toBe("ig");
  });
});
