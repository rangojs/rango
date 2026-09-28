// Dogfood (issue #939): the app's own "use cache" function
// (src/cache-lab-data.ts, `"use cache: cache-lab"`) caches through the testing
// primitives. rangoUseCacheTransform() in vitest.rsc.config.ts wraps it as the
// rango plugin does in dev; the plugin-rsc stub rangoTestAliases() ships runs
// the Flight codec. Each body run mints a random cacheToken, so an equal token
// is a body that did not run again.
import { describe, expect, it, vi } from "vitest";
import { runLoader } from "@rangojs/router/testing";
import {
  findClientBoundaries,
  renderHandler,
} from "@rangojs/router/testing/flight";
import { MemorySegmentCacheStore } from "@rangojs/router/cache";
import { getCacheLabProduct } from "../src/cache-lab-data.js";
import { CacheLabPage } from "../src/pages/cache-lab.js";

function spiedStore() {
  const cacheStore = new MemorySegmentCacheStore();
  const getItem = vi.spyOn(cacheStore, "getItem");
  const setItem = vi.spyOn(cacheStore, "setItem");
  return {
    options: {
      cacheStore,
      cacheProfiles: { "cache-lab": { ttl: 3600, swr: 300 } },
    },
    /** Settle the first `count` writes (background waitUntil tasks). */
    async written(count: number) {
      await vi.waitFor(() => expect(setItem).toHaveBeenCalledTimes(count));
      await Promise.all(setItem.mock.results.map((result) => result.value));
    },
    /** Hit (true) or miss (false) for each lookup so far. */
    lookups() {
      return Promise.all(
        getItem.mock.results.map(
          async (result) => (await result.value) !== null,
        ),
      );
    },
  };
}

function productTokens(tree: unknown): string[] {
  const [grid] = findClientBoundaries(tree, "CacheLabProductGrid");
  const { products } = grid!.props as {
    products: { product: { cacheToken: string } }[];
  };
  return products.map(({ product }) => product.cacheToken);
}

describe('"use cache" hit through the testing primitives (cloudflare-basic)', () => {
  it("renderHandler: CacheLabPage's second render reads both products from the store", async () => {
    const store = spiedStore();
    const options = { request: "/cache-lab?probe=dogfood", ...store.options };

    const first = await renderHandler(CacheLabPage, options);
    await store.written(2);
    const second = await renderHandler(CacheLabPage, options);

    expect(await store.lookups()).toEqual([false, false, true, true]);
    expect(productTokens(first.tree)).toHaveLength(2);
    expect(productTokens(second.tree)).toEqual(productTokens(first.tree));
  });

  it("runLoader: the second call reads the product from the store", async () => {
    const store = spiedStore();
    const load = () =>
      runLoader(
        async () => getCacheLabProduct("beta", "loader"),
        store.options,
      );

    const first = await load();
    await store.written(1);

    expect(await load()).toEqual(first);
    expect(await store.lookups()).toEqual([false, true]);
  });
});
