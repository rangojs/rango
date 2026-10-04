/**
 * VercelCacheStore keys with the versions of the router serving the request,
 * the same rule as CFCacheStore (docs/design/per-app-cache-version.md): the
 * data version for segments and items, the document version for responses and
 * shells, no version for tag markers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VercelCacheStore,
  type VercelRuntimeCache,
} from "../vercel-cache-store.js";
import type { CachedEntryData, ShellCacheEntry } from "../../types.js";
import { CACHE_READ_ERROR } from "../../types.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../../server/request-context.js";
import { installRouterVersionsTable } from "../../../server/build-version-table.js";
import type { RouterVersions } from "../../../router-versions.js";

/** The platform cache: one flat keyspace; expireTag deletes tagged entries. */
function makeFakeCache() {
  const store = new Map<
    string,
    { value: unknown; expiresAt: number | null; tags: string[] }
  >();
  const expired: string[][] = [];
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
        tags: options?.tags ?? [],
      });
    },
    async delete(key) {
      store.delete(key);
    },
    async expireTag(tag) {
      const tags = Array.isArray(tag) ? tag : [tag];
      expired.push(tags);
      for (const [key, entry] of store) {
        if (entry.tags.some((t) => tags.includes(t))) store.delete(key);
      }
    },
  };
  /** Stored keys, without the herd-dampening lock companions. */
  const keys = () => [...store.keys()].filter((key) => !key.endsWith(":lock"));
  return { cache, store, keys, expired };
}

const segment = (tags?: string[]): CachedEntryData => ({
  segments: [],
  handles: "",
  expiresAt: 0,
  ...(tags ? { tags } : {}),
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

describe("VercelCacheStore per-router versions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_800_000_000_000));
  });

  afterEach(() => {
    installRouterVersionsTable(undefined);
    vi.useRealTimers();
  });

  /** Run `fn` as a request served by a router with `versions`. */
  function request<T>(
    cache: VercelRuntimeCache,
    versions: RouterVersions | undefined,
    fn: (store: VercelCacheStore) => Promise<T>,
    options: { version?: string } = {},
  ): Promise<T> {
    // A store per request, as the cache factory builds it.
    const store = new VercelCacheStore({ cache, ...options });
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com/"),
      url: new URL("https://example.com/"),
      variables: {},
      cacheStore: store,
      versions,
    });
    return runWithRequestContext(ctx, () => fn(store));
  }

  const segmentHit = async (
    cache: VercelRuntimeCache,
    versions: RouterVersions,
  ) =>
    request(cache, versions, async (store) => {
      const result = await store.get("k");
      return result !== null && result !== CACHE_READ_ERROR;
    });

  describe("key per family", () => {
    it("keys each family with its version", async () => {
      const { cache, keys } = makeFakeCache();
      await request(cache, A1, async (store) => {
        await store.set("k", segment(), 60, 300);
        await store.setItem("item", "value", { ttl: 60 });
        await store.putResponse("/page", new Response("x"), 60);
        await store.putShell("/p:shell", shellEntry(), 60);
      });
      expect(keys().sort()).toEqual([
        "v/dataA/rg:i:item",
        "v/dataA/rg:s:k",
        "v/docA/rg:h:/p:shell",
        "v/docA/rg:r:/page",
      ]);
    });

    it("keys a tag marker with no version", async () => {
      const { cache, keys } = makeFakeCache();
      await request(cache, A1, (store) => store.invalidateTags(["products"]));
      expect(keys()).toEqual(["rg:tm:products"]);
    });

    it("passes the platform the tags as written, with no version", async () => {
      const { cache, store: stored, expired } = makeFakeCache();
      await request(cache, A1, async (store) => {
        await store.set("k", segment(["products"]), 60, 300);
        await store.invalidateTags(["products"]);
      });
      expect(expired).toEqual([["products"]]);
      // expireTag reached the entry by its tag, whatever version keyed it.
      expect(stored.has("v/dataA/rg:s:k")).toBe(false);
    });

    it("uses a store-level version for every versioned family", async () => {
      const { cache, keys } = makeFakeCache();
      await request(
        cache,
        A1,
        async (store) => {
          await store.set("k", segment(), 60, 300);
          await store.putResponse("/page", new Response("x"), 60);
        },
        { version: "pinned" },
      );
      expect(keys().sort()).toEqual(["v/pinned/rg:r:/page", "v/pinned/rg:s:k"]);
    });

    it("keys unversioned when the router's versions are empty (tests, the stub)", async () => {
      const { cache, keys } = makeFakeCache();
      await request(cache, { data: "", document: "" }, (store) =>
        store.set("k", segment(), 60, 300),
      );
      expect(keys()).toEqual(["rg:s:k"]);
    });

    it("uses the whole-build versions when no router set any on the context", async () => {
      installRouterVersionsTable({ "*": ["wholeData", "wholeDoc"] });
      const { cache, keys } = makeFakeCache();
      await request(cache, undefined, (store) =>
        store.set("k", segment(), 60, 300),
      );
      expect(keys()).toEqual(["v/wholeData/rg:s:k"]);
    });
  });

  describe("what a deploy keeps", () => {
    it("serves a segment entry to a deploy with the same data version", async () => {
      const { cache } = makeFakeCache();
      await request(cache, A1, (store) => store.set("k", segment(), 60, 300));
      expect(
        await segmentHit(cache, { data: "dataA", document: "docA2" }),
      ).toBe(true);
    });

    it("misses it after the router's data version changed, or under another router", async () => {
      const { cache } = makeFakeCache();
      await request(cache, A1, (store) => store.set("k", segment(), 60, 300));
      expect(
        await segmentHit(cache, { data: "dataA2", document: "docA2" }),
      ).toBe(false);
      expect(await segmentHit(cache, B1)).toBe(false);
    });

    it("misses stored HTML after only the document version changed", async () => {
      const { cache } = makeFakeCache();
      await request(cache, A1, async (store) => {
        await store.putResponse("/page", new Response("x"), 60);
        await store.putShell("/p:shell", shellEntry(), 60);
      });
      const clientOnlyDeploy = { data: "dataA", document: "docA2" };
      expect(
        await request(cache, clientOnlyDeploy, (store) =>
          store.getResponse("/page"),
        ),
      ).toBeNull();
      expect(
        await request(cache, clientOnlyDeploy, (store) =>
          store.getShell("/p:shell"),
        ),
      ).toBeNull();
      expect(
        await request(cache, A1, (store) => store.getResponse("/page")),
      ).not.toBeNull();
    });
  });

  describe("rollback: a tag invalidation applies across versions", () => {
    const deployA = A1;
    const deployB: RouterVersions = { data: "dataA2", document: "docA2" };

    it("a marker written under deploy B is what deploy A's write gate reads", async () => {
      const { cache } = makeFakeCache();
      const since = Date.now();
      vi.advanceTimersByTime(1_000);
      await request(cache, deployB, (store) =>
        store.invalidateTags(["products"]),
      );
      expect(
        await request(cache, deployA, (store) =>
          store.isTagsInvalidatedSince(["products"], since),
        ),
      ).toBe(true);
    });

    it("an invalidation made under deploy B removes deploy A's tagged entry", async () => {
      const { cache } = makeFakeCache();
      await request(cache, deployA, (store) =>
        store.set("k", segment(["products"]), 60, 300),
      );
      vi.advanceTimersByTime(1_000);
      await request(cache, deployB, (store) =>
        store.invalidateTags(["products"]),
      );
      expect(await segmentHit(cache, deployA)).toBe(false);
    });

    it("a shell deploy A captured before the invalidation is not served after the rollback", async () => {
      const { cache } = makeFakeCache();
      // Untagged at the platform (so expireTag cannot delete it): the marker
      // check is all that stands between the rollback and the stale shell.
      const untaggedSet = cache.set.bind(cache);
      cache.set = (key, value, options) =>
        untaggedSet(key, value, { ...options, tags: undefined });
      await request(cache, deployA, (store) =>
        store.putShell("/p:shell", shellEntry(), 60, undefined, ["products"]),
      );
      expect(
        await request(cache, deployA, (store) => store.getShell("/p:shell")),
      ).not.toBeNull();
      vi.advanceTimersByTime(1_000);
      await request(cache, deployB, (store) =>
        store.invalidateTags(["products"]),
      );
      expect(
        await request(cache, deployA, (store) => store.getShell("/p:shell")),
      ).toBeNull();
    });
  });
});
