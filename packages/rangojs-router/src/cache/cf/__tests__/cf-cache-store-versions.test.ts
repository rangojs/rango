/**
 * CFCacheStore keys with the versions of the router serving the request
 * (docs/design/per-app-cache-version.md): cached data under the data version,
 * stored HTML under the document version, tag markers under none.
 *
 * A "deploy" here is a request context carrying different versions: the store
 * is built per request by the cache factory and reads the versions from the
 * context on every operation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CFCacheStore,
  resetCFShellMemoForTests,
  TAG_MARKER_PREFIX,
} from "../cf-cache-store";
import type { CachedEntryData, ShellCacheEntry } from "../../types";
import { CACHE_READ_ERROR } from "../../types.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../../server/request-context";
import { installRouterVersionsTable } from "../../../server/build-version-table.js";
import type { RouterVersions } from "../../../router-versions.js";

class MockCache {
  store = new Map<string, Response>();
  async match(request: Request): Promise<Response | undefined> {
    return this.store.get(request.url)?.clone();
  }
  async put(request: Request, response: Response): Promise<void> {
    this.store.set(request.url, response.clone());
  }
  async delete(request: Request): Promise<boolean> {
    return this.store.delete(request.url);
  }
  urls(): string[] {
    return [...this.store.keys()].map((url) => decodeURIComponent(url));
  }
}

class MockKV {
  store = new Map<string, string>();
  async get(key: string, options?: { type?: string }): Promise<any> {
    const raw = this.store.get(key);
    if (raw === undefined) return null;
    return options?.type === "json" ? JSON.parse(raw) : raw;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  keys(): string[] {
    return [...this.store.keys()];
  }
}

function createMockCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(Promise.resolve(promise));
    },
    passThroughOnException: () => {},
    flush: async () => {
      while (pending.length) await Promise.all(pending.splice(0));
    },
  };
}

const segmentData = (tags?: string[]): CachedEntryData => ({
  segments: [
    {
      encoded: "c",
      metadata: {
        id: "seg",
        type: "route",
        namespace: "test",
        index: 0,
        params: {},
      },
    },
  ],
  handles: "",
  expiresAt: Date.now() + 600_000,
  tags,
});

const shellEntry = (): ShellCacheEntry => ({
  prelude: btoa("<html><body>SHELL</body></html>"),
  postponed: JSON.stringify({ hole: 1 }),
  reactVersion: "19.3.0",
  buildVersion: "doc",
  createdAt: Date.now(),
  snapshot: [],
});

const A1: RouterVersions = { data: "dataA", document: "docA" };
const B1: RouterVersions = { data: "dataB", document: "docB" };

describe("CFCacheStore per-router versions", () => {
  let cache: MockCache;
  let kv: MockKV;
  let ctx: ReturnType<typeof createMockCtx>;

  beforeEach(() => {
    vi.restoreAllMocks();
    resetCFShellMemoForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    cache = new MockCache();
    kv = new MockKV();
    ctx = createMockCtx();
    vi.stubGlobal("caches", { default: cache, open: async () => cache });
  });

  afterEach(() => {
    installRouterVersionsTable(undefined);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const makeStore = (overrides: Record<string, unknown> = {}) =>
    new CFCacheStore({
      ctx: ctx as any,
      kv: kv as any,
      baseUrl: "https://test.internal/",
      ...overrides,
    });

  /** Run `fn` as a request served by a router with `versions`. */
  async function request<T>(
    versions: RouterVersions | undefined,
    fn: (store: CFCacheStore) => Promise<T>,
    store: CFCacheStore = makeStore(),
  ): Promise<T> {
    const reqCtx = createRequestContext({
      env: {},
      request: new Request("https://test.internal/"),
      url: new URL("https://test.internal/"),
      variables: {},
      cacheStore: store,
      versions,
    });
    const result = await runWithRequestContext(reqCtx, () => fn(store));
    await ctx.flush();
    return result;
  }

  const segmentHit = async (versions: RouterVersions, key = "k") =>
    request(versions, async (store) => {
      const result = await store.get(key);
      return result !== null && result !== CACHE_READ_ERROR;
    });

  describe("key per family", () => {
    it("keys a segment entry with the data version, in both tiers", async () => {
      await request(A1, (store) => store.set("k", segmentData(), 300));
      expect(cache.urls()).toEqual(["https://test.internal/v/dataA/k"]);
      expect(kv.keys()).toEqual(["v/dataA/k"]);
    });

    it('keys a "use cache" item with the data version', async () => {
      await request(A1, (store) =>
        store.setItem("use-cache:fn:args", "value", { ttl: 300 }),
      );
      expect(cache.urls()).toEqual([
        "https://test.internal/v/dataA/fn:use-cache:fn:args",
      ]);
      expect(kv.keys()).toEqual(["v/dataA/fn:use-cache:fn:args"]);
    });

    it("keys a document response with the document version, in both tiers", async () => {
      await request(A1, (store) =>
        store.putResponse(
          "/page",
          new Response("<html></html>", {
            headers: { "content-type": "text/html" },
          }),
          300,
        ),
      );
      expect(cache.urls()).toEqual(["https://test.internal/v/docA/doc:/page"]);
      expect(kv.keys()).toEqual(["v/docA/h/test.internal/doc:/page"]);
    });

    it("keys a PPR shell with the document version, in both tiers", async () => {
      await request(A1, (store) =>
        store.putShell("/p:shell", shellEntry(), 300),
      );
      expect(cache.urls()).toEqual([
        "https://test.internal/v/docA/shell2:/p:shell",
      ]);
      expect(kv.keys()).toEqual(["v/docA/shell2:/p:shell"]);
    });

    it("keys a tag marker with no version, in KV and in L1", async () => {
      await request(A1, (store) => store.invalidateTags(["products"]));
      expect(kv.keys()).toEqual([`${TAG_MARKER_PREFIX}products`]);
      for (const url of cache.urls()) expect(url).not.toContain("/v/");
    });

    it("uses a store-level version for every versioned family", async () => {
      const store = makeStore({ version: "pinned" });
      await request(
        A1,
        async (pinned) => {
          await pinned.set("k", segmentData(), 300);
          await pinned.setItem("item", "value", { ttl: 300 });
          await pinned.putResponse("/page", new Response("x"), 300);
          await pinned.putShell("/p:shell", shellEntry(), 300);
        },
        store,
      );
      expect(kv.keys().sort()).toEqual([
        "v/pinned/fn:item",
        "v/pinned/h/test.internal/doc:/page",
        "v/pinned/k",
        "v/pinned/shell2:/p:shell",
      ]);
    });

    it("keys unversioned when the router's versions are empty (tests, the stub)", async () => {
      await request({ data: "", document: "" }, (store) =>
        store.set("k", segmentData(), 300),
      );
      expect(kv.keys()).toEqual(["k"]);
    });

    it("uses the whole-build versions when no router set any on the context", async () => {
      installRouterVersionsTable({ "*": ["wholeData", "wholeDoc"] });
      await request(undefined, (store) => store.set("k", segmentData(), 300));
      expect(kv.keys()).toEqual(["v/wholeData/k"]);
    });
  });

  describe("what a deploy keeps", () => {
    it("serves a segment entry to a deploy with the same data version", async () => {
      await request(A1, (store) => store.set("k", segmentData(), 300));
      // A client-only deploy: same server code, new client assets.
      expect(await segmentHit({ data: "dataA", document: "docA2" })).toBe(true);
    });

    it("misses a segment entry after the router's data version changed", async () => {
      await request(A1, (store) => store.set("k", segmentData(), 300));
      expect(await segmentHit({ data: "dataA2", document: "docA2" })).toBe(
        false,
      );
    });

    it("misses stored HTML after only the document version changed", async () => {
      await request(A1, async (store) => {
        await store.putResponse("/page", new Response("<html></html>"), 300);
        await store.putShell("/p:shell", shellEntry(), 300);
      });
      const clientOnlyDeploy = { data: "dataA", document: "docA2" };
      expect(
        await request(clientOnlyDeploy, (store) => store.getResponse("/page")),
      ).toBeNull();
      resetCFShellMemoForTests();
      expect(
        await request(clientOnlyDeploy, (store) => store.getShell("/p:shell")),
      ).toBeNull();
      // ...and the same deploy's versions still find them.
      expect(
        await request(A1, (store) => store.getResponse("/page")),
      ).not.toBeNull();
      expect(
        await request(A1, (store) => store.getShell("/p:shell")),
      ).not.toBeNull();
    });

    it("keeps two routers of one isolate apart on the same key", async () => {
      await request(A1, (store) => store.set("k", segmentData(), 300));
      expect(await segmentHit(B1)).toBe(false);
      expect(await segmentHit(A1)).toBe(true);
    });
  });

  describe("rollback: a tag invalidation applies across versions", () => {
    const deployA = A1;
    const deployB: RouterVersions = { data: "dataA2", document: "docA2" };

    it("an invalidation made under deploy B makes deploy A's entry stale after a rollback to A", async () => {
      // Deploy A writes a tagged entry.
      await request(deployA, (store) =>
        store.set("k", segmentData(["products"]), 300),
      );
      expect(await segmentHit(deployA)).toBe(true);

      // Deploy B is live; a product changes.
      vi.advanceTimersByTime(1_000);
      await request(deployB, (store) => store.invalidateTags(["products"]));

      // Roll back to A: A's version is live again, with what A wrote.
      // A fresh isolate: no per-isolate marker memo to answer from.
      resetCFShellMemoForTests();
      vi.advanceTimersByTime(60_000);
      expect(await segmentHit(deployA)).toBe(false);
    });

    it("the isolate's marker memo, which shell reads use, answers for every version too", async () => {
      await request(deployA, (store) =>
        store.putShell("/p:shell", shellEntry(), 300, undefined, ["products"]),
      );
      expect(
        await request(deployA, (store) => store.getShell("/p:shell")),
      ).not.toBeNull();
      vi.advanceTimersByTime(1_000);
      await request(deployB, (store) => store.invalidateTags(["products"]));
      // Take the durable and edge markers away: only the memo the
      // invalidating request filled can still say the tag was invalidated.
      kv.store.delete(`${TAG_MARKER_PREFIX}products`);
      for (const url of [...cache.store.keys()]) {
        if (decodeURIComponent(url).includes("__tagmarker__")) {
          cache.store.delete(url);
        }
      }
      expect(
        await request(deployA, (store) => store.getShell("/p:shell")),
      ).toBeNull();
    });

    it("the same holds for an item and a document response", async () => {
      await request(deployA, async (store) => {
        await store.setItem("item", "value", { ttl: 300, tags: ["products"] });
        await store.putResponse(
          "/page",
          new Response("<html></html>"),
          300,
          undefined,
          ["products"],
        );
      });
      vi.advanceTimersByTime(1_000);
      await request(deployB, (store) => store.invalidateTags(["products"]));
      vi.advanceTimersByTime(60_000);
      expect(
        await request(deployA, (store) => store.getItem("item")),
      ).toBeNull();
      expect(
        await request(deployA, (store) => store.getResponse("/page")),
      ).toBeNull();
    });

    it("an entry written after the invalidation, under either version, is served", async () => {
      await request(deployB, (store) => store.invalidateTags(["products"]));
      vi.advanceTimersByTime(1_000);
      await request(deployA, (store) =>
        store.set("k", segmentData(["products"]), 300),
      );
      expect(await segmentHit(deployA)).toBe(true);
    });

    it("the write gate sees an invalidation made under another version", async () => {
      const since = Date.now();
      vi.advanceTimersByTime(1_000);
      await request(deployB, (store) => store.invalidateTags(["products"]));
      expect(
        await request(deployA, (store) =>
          store.isTagsInvalidatedSince(["products"], since),
        ),
      ).toBe(true);
    });
  });
});
