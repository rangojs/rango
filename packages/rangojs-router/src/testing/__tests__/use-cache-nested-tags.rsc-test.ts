/**
 * A "use cache" function that calls another (issue #980), through runLoader
 * in the react-server Flight project. The outer entry bakes the inner value,
 * so it carries the inner function's tags, from the inner miss or from the
 * inner entry on a hit: updateTag() of an inner tag evicts the outer entry,
 * and the same-request gate (#973) treats the outer execution as tagged by it.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import { runInRequestContext, runLoader } from "../index.js";
import { revalidateTag, updateTag } from "../../cache/tag-invalidation.js";
import { MemorySegmentCacheStore } from "../../cache/memory-segment-store.js";
import {
  getHeldInner,
  getHeldOuter,
  getLazyShelf,
  getShelfCard,
  getShelfPanel,
  getShelfStock,
  getStockCard,
  getVersionedInner,
  getVersionedOuter,
  innerGate,
  runs,
  shelfSource,
} from "./fixtures/use-cache-data.js";

function spiedStore() {
  const cacheStore = new MemorySegmentCacheStore();
  const setItem = vi.spyOn(cacheStore, "setItem");
  return {
    cacheStore,
    setItem,
    options: { cacheStore, cacheProfiles: { default: { ttl: 60 } } },
    /** Settle the first `count` writes. */
    async written(count: number) {
      await vi.waitFor(() => expect(setItem).toHaveBeenCalledTimes(count));
      await Promise.all(setItem.mock.results.map((result) => result.value));
    },
    /** The tags each write stored, keyed by the cache key's function. */
    tagsOf(fn: string): (string[] | undefined)[] {
      return setItem.mock.calls
        .filter(([key]) => key.includes(`_${fn}:`))
        .map(([, , options]) => options?.tags);
    },
  };
}

describe('a "use cache" function calling another (#980)', () => {
  it("updateTag() of the inner function's tag evicts the outer entry", async () => {
    const store = spiedStore();
    runs.getShelfCard = 0;
    runs.getShelfStock = 0;
    shelfSource.value = "old";
    const read = () => runLoader(() => getShelfCard("tea"), store.options);

    // Miss: both bodies run and both entries are written.
    expect(await read()).toEqual({ stock: "tea:old" });
    await store.written(2);

    // Hit: neither body runs.
    expect(await read()).toEqual({ stock: "tea:old" });
    expect([runs.getShelfCard, runs.getShelfStock]).toEqual([1, 1]);

    shelfSource.value = "new";
    await runInRequestContext(() => updateTag("shelf"), {
      cacheStore: store.cacheStore,
    });

    // Miss with the new value: the outer entry went with the inner one.
    expect(await read()).toEqual({ stock: "tea:new" });
    expect([runs.getShelfCard, runs.getShelfStock]).toEqual([2, 2]);
  });

  it("an outer miss over an inner hit stores the inner entry's tags", async () => {
    const store = spiedStore();
    runs.getShelfCard = 0;
    runs.getShelfStock = 0;
    shelfSource.value = "old";

    // The inner entry first, read on its own.
    await runLoader(() => getShelfStock("mate"), store.options);
    await store.written(1);
    // The outer miss reads the inner entry: the inner body does not run.
    expect(await runLoader(() => getShelfCard("mate"), store.options)).toEqual({
      stock: "mate:old",
    });
    await store.written(2);
    expect(runs.getShelfStock).toBe(1);
    expect(store.tagsOf("getShelfCard")).toEqual([["shelf"]]);

    shelfSource.value = "new";
    await runInRequestContext(() => updateTag("shelf"), {
      cacheStore: store.cacheStore,
    });
    expect(await runLoader(() => getShelfCard("mate"), store.options)).toEqual({
      stock: "mate:new",
    });
  });

  it('a "use cache" component whose value renders another "use cache" call stores its tags', async () => {
    const store = spiedStore();
    runs.getShelfPanel = 0;
    runs.getShelfStock = 0;
    shelfSource.value = "old";
    const read = () => runLoader(() => getShelfPanel("chai"), store.options);

    // The inner call runs while Flight encodes the panel for its write.
    await read();
    await store.written(2);
    expect(runs.getShelfStock).toBe(1);
    expect(store.tagsOf("getShelfPanel")).toEqual([["shelf"]]);

    await read();
    expect(runs.getShelfPanel).toBe(1);
    await runInRequestContext(() => updateTag("shelf"), {
      cacheStore: store.cacheStore,
    });
    await read();
    expect(runs.getShelfPanel).toBe(2);
  });

  // getLazyCard returns getLazyStock's promise unawaited: that call records
  // its tags after getLazyCard reported its own to getLazyShelf.
  it("a tag an intermediate call records after it returned reaches the outermost entry", async () => {
    const store = spiedStore();
    runs.getLazyShelf = 0;
    shelfSource.value = "old";
    const read = () => runLoader(() => getLazyShelf("oat"), store.options);

    await read();
    await store.written(3);
    expect(store.tagsOf("getLazyCard")).toEqual([["zz-inner"]]);
    expect(store.tagsOf("getLazyShelf")).toEqual([["zz-inner"]]);

    await read();
    expect(runs.getLazyShelf).toBe(1);
    await runInRequestContext(() => updateTag("zz-inner"), {
      cacheStore: store.cacheStore,
    });
    await read();
    expect(runs.getLazyShelf).toBe(2);
  });

  // The inner call joins an execution another call leads: its tags come from
  // the leader's envelope.
  it("an inner call that joins an execution in flight gives the outer entry its tags", async () => {
    const store = spiedStore();
    runs.getHeldInner = 0;
    let release!: () => void;
    innerGate.held = new Promise<void>((resolve) => (release = resolve));
    try {
      await runLoader(async () => {
        const leader = getHeldInner("rye");
        await vi.waitFor(() => expect(runs.getHeldInner).toBe(1));
        const outer = getHeldOuter("rye");
        await pause(5);
        release();
        await Promise.all([leader, outer]);
      }, store.options);
      await store.written(2);
    } finally {
      innerGate.held = Promise.resolve();
    }

    expect(runs.getHeldInner).toBe(1);
    expect(store.tagsOf("getHeldOuter")).toEqual([["held-inner"]]);
  });

  // The outer bakes the stale value; the refresh's value goes only to the
  // inner entry, so its tags must not reach the outer one.
  it("a stale inner entry's background refresh records nothing onto the outer entry", async () => {
    const store = spiedStore();
    const options = {
      cacheStore: store.cacheStore,
      cacheProfiles: { default: { ttl: 60 }, stale: { ttl: 0, swr: 60 } },
    };
    runs.getVersionedInner = 0;
    await runLoader(() => getVersionedInner("bran"), options);
    await store.written(1);
    await pause(5);

    expect(await runLoader(() => getVersionedOuter("bran"), options)).toBe(
      "bran:v1",
    );
    await vi.waitFor(() =>
      expect(store.tagsOf("getVersionedOuter")).toHaveLength(1),
    );
    await store.written(3);

    expect(runs.getVersionedInner).toBe(2);
    expect(store.tagsOf("getVersionedOuter")).toEqual([["versioned-v1"]]);
    // The refresh still tags its own entry.
    expect(store.tagsOf("getVersionedInner")).toEqual([
      ["versioned-v1"],
      ["versioned-v2"],
    ]);
  });

  // The #973 gate: an outer call made earlier in the request, its write
  // still pending, is neither reused nor written after the request
  // invalidates a tag only its inner function recorded.
  it.each(["revalidateTag", "updateTag"] as const)(
    "%s: the same-request gate covers a tag the inner function recorded",
    async (verb) => {
      runs.getStock = 0;
      const store = spiedStore();
      const values = await runLoader(async () => {
        const before = await getStockCard("stout");
        if (verb === "updateTag") await updateTag("stock");
        else revalidateTag("stock");
        const after = await getStockCard("stout");
        return [before, after];
      }, store.options);

      expect(values).toEqual(["card(stout #1)", "card(stout #2)"]);
      await pause(50);
      const written = store.setItem.mock.calls.map(([, value]) =>
        String(value),
      );
      expect(written.some((value) => value.includes("stout #1"))).toBe(false);
    },
  );
});

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
