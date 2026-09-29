/**
 * A loader's own cache() binding (`loader(Loader, () => [cache({...})])`)
 * through runLoader's `cache` option (#964), in the react-server Flight
 * project: the value round-trips through a real Flight encode, and the codec
 * is the plugin-rsc stub rangoTestAliases ships.
 *
 * The body's cacheTag() tags are stored on the entry, so updateTag() of one
 * drops it and the next call runs the body again. The write is a background
 * task runLoader does not await: each test waits for it.
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

import {
  runInRequestContext,
  runLoader,
  type TestLoaderContext,
} from "../index.js";
import { MemorySegmentCacheStore } from "../../cache/memory-segment-store.js";
import { cacheTag } from "../../cache/cache-tag.js";
import { updateTag } from "../../cache/tag-invalidation.js";

function spiedStore() {
  const cacheStore = new MemorySegmentCacheStore();
  const setItem = vi.spyOn(cacheStore, "setItem");
  return {
    cacheStore,
    /** Settle the first `count` writes. */
    async written(count: number) {
      await vi.waitFor(() => expect(setItem).toHaveBeenCalledTimes(count));
      await Promise.all(setItem.mock.results.map((result) => result.value));
    },
  };
}

describe("runLoader: a loader's own cache()", () => {
  it("updateTag() of a tag the body recorded drops the entry", async () => {
    const store = spiedStore();
    let runs = 0;
    const productLoader = async (ctx: TestLoaderContext) => {
      runs++;
      cacheTag(`product:${ctx.params.id}`);
      return { id: ctx.params.id, run: runs };
    };
    const load = () =>
      runLoader(productLoader, {
        params: { id: "1" },
        cacheStore: store.cacheStore,
        cache: { ttl: 300, tags: ["products"] },
      });

    expect(await load()).toEqual({ id: "1", run: 1 });
    await store.written(1);
    // A HIT: the stored value, the body did not run.
    expect(await load()).toEqual({ id: "1", run: 1 });

    await runInRequestContext(() => updateTag("product:1"), {
      cacheStore: store.cacheStore,
    });

    expect(await load()).toEqual({ id: "1", run: 2 });
    await store.written(2);
    expect(await load()).toEqual({ id: "1", run: 2 });
    expect(runs).toBe(2);
  });

  it("another params value is its own entry", async () => {
    const store = spiedStore();
    let runs = 0;
    const productLoader = async (ctx: TestLoaderContext) => {
      runs++;
      return { id: ctx.params.id };
    };
    const load = (id: string) =>
      runLoader(productLoader, {
        params: { id },
        cacheStore: store.cacheStore,
        cache: { ttl: 300 },
      });

    await load("1");
    await store.written(1);
    expect(await load("2")).toEqual({ id: "2" });
    await store.written(2);
    expect(await load("1")).toEqual({ id: "1" });
    expect(runs).toBe(2);
  });
});
