import { beforeEach, describe, expect, it } from "vitest";
import { runInRequestContext } from "@rangojs/router/testing";
import { MemorySegmentCacheStore } from "@rangojs/router/cache";
import { publishProductAction } from "../src/actions/cache-tags.js";

// Dogfood server-side cache TAG invalidation (updateTag) through
// runInRequestContext against the app's REAL action. MemorySegmentCacheStore is
// tag-capable (it implements invalidateTags), so this is a genuine in-process
// unit assertion - no CFCacheStore/KV needed. CFCacheStore+KV is only required
// to verify the distributed cross-colo marker purge, which stays at the e2e layer.

describe("cache-tag invalidation against cloudflare-basic actions", () => {
  beforeEach(() => {
    MemorySegmentCacheStore.resetGlobalCache();
  });

  it("publishProductAction: updateTag('products') evicts products-tagged entries (read-your-own-writes), leaving others", async () => {
    const store = new MemorySegmentCacheStore();
    await store.setItem("products:list", "cached", {
      ttl: 60,
      tags: ["products"],
    });
    await store.setItem("orders:list", "cached", {
      ttl: 60,
      tags: ["orders"],
    });

    const { result } = await runInRequestContext(() => publishProductAction(), {
      cacheStore: store,
    });

    expect(result).toEqual({ ok: true });
    // The products-tagged entry is gone immediately after the awaited updateTag
    // (read-your-own-writes); a differently-tagged entry is untouched.
    expect(await store.getItem("products:list")).toBeNull();
    expect(await store.getItem("orders:list")).not.toBeNull();
  });
});
