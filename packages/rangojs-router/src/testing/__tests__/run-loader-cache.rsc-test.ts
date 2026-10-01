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
import { cookies } from "../../server/cookie-store.js";

function spiedStore() {
  const cacheStore = new MemorySegmentCacheStore();
  const setItem = vi.spyOn(cacheStore, "setItem");
  return {
    cacheStore,
    setItem,
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

  describe("a body that reads cookies() (#972)", () => {
    const sessionLoader = async () => ({
      session: cookies().get("session")?.value,
    });
    const asUser = (session: string) =>
      new Request("http://localhost/account", {
        headers: { cookie: `session=${session}` },
      });

    it("throws without a key(): the entry would be shared across users", async () => {
      const store = spiedStore();

      await expect(
        runLoader(sessionLoader, {
          request: asUser("a"),
          cacheStore: store.cacheStore,
          cache: { ttl: 300 },
        }),
      ).rejects.toThrow(
        /cookies\(\) cannot be called inside loader "runLoader#\d+", whose own cache\(\) has no key\(\)/,
      );
      expect(store.setItem).not.toHaveBeenCalled();
    });

    it("with a key() that reads the cookie, each user gets their own entry", async () => {
      const store = spiedStore();
      const load = (session: string) =>
        runLoader(sessionLoader, {
          request: asUser(session),
          cacheStore: store.cacheStore,
          cache: {
            ttl: 300,
            key: () => `session:${cookies().get("session")?.value}`,
          },
        });

      expect(await load("a")).toEqual({ session: "a" });
      await store.written(1);
      expect(await load("b")).toEqual({ session: "b" });
      await store.written(2);
      // A HIT for user a: the stored value, not user b's.
      expect(await load("a")).toEqual({ session: "a" });
    });
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

  describe("a key() that returns request input (#1009)", () => {
    const accountLoader = async () => ({ from: "account" });
    const variantLoader = async () => ({ from: "variant" });
    type Store = ReturnType<typeof spiedStore>;
    const loadAccount = (store: Store) =>
      runLoader(accountLoader, {
        request: "http://localhost/account",
        cacheStore: store.cacheStore,
        cache: { ttl: 300 },
      });
    const loadVariant = (store: Store, variant: string) =>
      runLoader(variantLoader, {
        request: new Request("http://localhost/other", {
          headers: { "x-variant": variant },
        }),
        cacheStore: store.cacheStore,
        cache: {
          ttl: 300,
          key: (ctx) => ctx.request.headers.get("x-variant") ?? "",
        },
      });
    /** The key the account loader's own entry is stored under. */
    async function accountKey(): Promise<string> {
      const store = spiedStore();
      await loadAccount(store);
      await store.written(1);
      return store.setItem.mock.calls[0][0];
    }

    it("naming another loader's entry does not read it", async () => {
      const store = spiedStore();
      await loadAccount(store);
      await store.written(1);
      const key = store.setItem.mock.calls[0][0];

      expect(await loadVariant(store, key)).toEqual({ from: "variant" });
    });

    it("naming another loader's entry does not overwrite it", async () => {
      const key = await accountKey();
      const store = spiedStore();
      await loadVariant(store, key);
      await store.written(1);

      expect(await loadAccount(store)).toEqual({ from: "account" });
    });
  });
});
