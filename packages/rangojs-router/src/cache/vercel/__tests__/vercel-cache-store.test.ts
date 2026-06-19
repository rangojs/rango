import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  VercelCacheStore,
  VERCEL_MAX_ITEM_BYTES,
  VERCEL_MAX_TAGS_PER_ITEM,
  type VercelRuntimeCache,
  type VercelCacheReadDebugEvent,
} from "../vercel-cache-store.js";
import type { CachedEntryData } from "../../types.js";

/**
 * In-memory fake of Vercel's RuntimeCache. JSON round-trips every stored value
 * to mimic the platform's serialization (so a non-JSON-safe envelope would be
 * caught here), honors a per-entry TTL using Date.now() (so vi.setSystemTime
 * drives both the store and the fake), and physically deletes tagged entries on
 * expireTag (the platform's delete model).
 */
function makeFakeCache(): {
  cache: VercelRuntimeCache;
  store: Map<
    string,
    { value: unknown; expiresAt: number | null; tags: string[] }
  >;
  failExpireTag: (fn: ((tag: string | string[]) => void) | null) => void;
} {
  const store = new Map<
    string,
    { value: unknown; expiresAt: number | null; tags: string[] }
  >();
  let expireTagHook: ((tag: string | string[]) => void) | null = null;

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
      if (expireTagHook) expireTagHook(tag);
      const tags = Array.isArray(tag) ? tag : [tag];
      for (const [key, entry] of store) {
        if (entry.tags.some((t) => tags.includes(t))) store.delete(key);
      }
    },
  };

  return {
    cache,
    store,
    failExpireTag: (fn) => {
      expireTagHook = fn;
    },
  };
}

function segment(tags?: string[]): CachedEntryData {
  return { segments: [], handles: "", expiresAt: 0, ...(tags ? { tags } : {}) };
}

const T0 = 1_700_000_000_000;

describe("VercelCacheStore", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    consoleError.mockRestore();
  });

  it("requires a cache handle", () => {
    expect(() => new VercelCacheStore({ cache: undefined as never })).toThrow(
      /requires `cache`/,
    );
  });

  describe("segment get/set/delete", () => {
    it("round-trips a fresh entry", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await s.set("k", segment(), 60, 300);
      const hit = await s.get("k");
      expect(hit).not.toBeNull();
      expect(hit?.shouldRevalidate).toBe(false);
      expect(hit?.data.segments).toEqual([]);
    });

    it("returns null on a miss", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      expect(await s.get("absent")).toBeNull();
    });

    it("delete reports success", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await s.set("k", segment(), 60);
      expect(await s.delete("k")).toBe(true);
      expect(await s.get("k")).toBeNull();
    });

    it("evicts and misses on a corrupt (non-envelope) stored value", async () => {
      const { cache, store } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      // Plant a value that is not a valid segment envelope under the store key.
      store.set("rg:s:k", {
        value: { not: "an envelope" },
        expiresAt: null,
        tags: [],
      });
      expect(await s.get("k")).toBeNull();
      expect(store.has("rg:s:k")).toBe(false); // self-healed
      expect(consoleError).toHaveBeenCalled();
    });
  });

  describe("stale-while-revalidate", () => {
    it("is fresh before staleAt, stale within the swr window, gone after", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await s.set("k", segment(), 60, 300); // staleAt=+60s, expiresAt=+360s

      vi.setSystemTime(new Date(T0 + 30_000));
      expect((await s.get("k"))?.shouldRevalidate).toBe(false);

      vi.setSystemTime(new Date(T0 + 120_000));
      expect((await s.get("k"))?.shouldRevalidate).toBe(true);

      vi.setSystemTime(new Date(T0 + 400_000));
      expect(await s.get("k")).toBeNull();
    });

    it("dampens the herd: a stale read re-stamps so the next read is fresh", async () => {
      const { cache } = makeFakeCache();
      const pending: Promise<unknown>[] = [];
      const s = new VercelCacheStore({
        cache,
        waitUntil: (p) => {
          pending.push(p);
        },
      });
      await s.set("k", segment(), 60, 300);

      vi.setSystemTime(new Date(T0 + 120_000));
      expect((await s.get("k"))?.shouldRevalidate).toBe(true);
      await Promise.all(pending); // let the re-stamp settle

      // Same instant: staleAt was pushed forward, so this read is fresh again.
      expect((await s.get("k"))?.shouldRevalidate).toBe(false);
    });
  });

  describe("tags", () => {
    it("invalidateTags expires tagged entries via expireTag", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await s.set("k", segment(["blog"]), 60, 300);
      expect(await s.get("k")).not.toBeNull();
      await s.invalidateTags(["blog"]);
      expect(await s.get("k")).toBeNull();
    });

    it("invalidateTags rejects when expireTag fails (read-your-own-writes)", async () => {
      const { cache, failExpireTag } = makeFakeCache();
      failExpireTag(() => {
        throw new Error("expireTag boom");
      });
      const s = new VercelCacheStore({ cache });
      await expect(s.invalidateTags(["x"])).rejects.toThrow("expireTag boom");
    });

    it("drops comma-bearing and over-length tags but keeps valid ones", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      const longTag = "a".repeat(300);
      await s.set("k", segment(["ok", "a,b", longTag]), 60, 300);
      // The bad tags never reached the backend, so they cannot invalidate.
      await s.invalidateTags(["a,b"]);
      expect(await s.get("k")).not.toBeNull();
      await s.invalidateTags(["ok"]);
      expect(await s.get("k")).toBeNull();
    });

    it("clamps tags per item on write; tags beyond the cap cannot invalidate", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      const overflow = VERCEL_MAX_TAGS_PER_ITEM + 1;
      const tags = Array.from({ length: overflow }, (_, i) => `t${i}`);
      await s.set("k", segment(tags), 60, 300);
      // The (cap+1)th tag is dropped on write, so it cannot invalidate.
      await s.invalidateTags([`t${VERCEL_MAX_TAGS_PER_ITEM}`]);
      expect(await s.get("k")).not.toBeNull();
      await s.invalidateTags(["t0"]); // kept (within the cap)
      expect(await s.get("k")).toBeNull();
    });

    it("documents the per-item tag cap as Vercel's getCache limit (128)", () => {
      expect(VERCEL_MAX_TAGS_PER_ITEM).toBe(128);
    });
  });

  describe("size guard", () => {
    it("skips a write above maxItemBytes (fail-open)", async () => {
      const { cache, store } = makeFakeCache();
      const s = new VercelCacheStore({ cache, maxItemBytes: 100 });
      const big: CachedEntryData = {
        segments: [
          {
            encoded: "x".repeat(500),
            metadata: {} as never,
          },
        ],
        handles: "",
        expiresAt: 0,
      };
      await s.set("k", big, 60, 300);
      expect(store.has("rg:s:k")).toBe(false);
      expect(consoleError).toHaveBeenCalled();
    });

    it("defaults the cap to 2 MB", () => {
      expect(VERCEL_MAX_ITEM_BYTES).toBe(2 * 1024 * 1024);
    });
  });

  describe('"use cache" items (getItem/setItem)', () => {
    it("round-trips a value with handles and tags", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await s.setItem("use-cache:fn", "SERIALIZED", {
        handles: "HANDLES",
        ttl: 60,
        swr: 300,
        tags: ["t"],
      });
      const hit = await s.getItem("use-cache:fn");
      expect(hit?.value).toBe("SERIALIZED");
      expect(hit?.handles).toBe("HANDLES");
      expect(hit?.tags).toEqual(["t"]);
      expect(hit?.shouldRevalidate).toBe(false);
    });

    it("surfaces shouldRevalidate when stale", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await s.setItem("use-cache:fn", "v", { ttl: 60, swr: 300 });
      vi.setSystemTime(new Date(T0 + 120_000));
      expect((await s.getItem("use-cache:fn"))?.shouldRevalidate).toBe(true);
    });

    it("is invalidated by tag", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await s.setItem("use-cache:fn", "v", { ttl: 60, tags: ["t"] });
      await s.invalidateTags(["t"]);
      expect(await s.getItem("use-cache:fn")).toBeNull();
    });
  });

  describe("response cache (getResponse/putResponse)", () => {
    it("round-trips status, headers, and body", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      const res = new Response("hello body", {
        status: 201,
        headers: { "content-type": "text/plain", "x-custom": "1" },
      });
      await s.putResponse("doc:k", res, 60, 300);
      const hit = await s.getResponse("doc:k");
      expect(hit).not.toBeNull();
      expect(hit?.response.status).toBe(201);
      expect(hit?.response.headers.get("x-custom")).toBe("1");
      expect(await hit?.response.text()).toBe("hello body");
      expect(hit?.shouldRevalidate).toBe(false);
    });

    it("strips per-client signal headers (Set-Cookie)", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      const res = new Response("x", {
        status: 200,
        headers: { "set-cookie": "session=secret", "x-keep": "1" },
      });
      await s.putResponse("doc:k", res, 60, 300);
      const hit = await s.getResponse("doc:k");
      expect(hit?.response.headers.get("set-cookie")).toBeNull();
      expect(hit?.response.headers.get("x-keep")).toBe("1");
    });

    it("expires the response after ttl+swr", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await s.putResponse("doc:k", new Response("x"), 60, 300);
      vi.setSystemTime(new Date(T0 + 400_000));
      expect(await s.getResponse("doc:k")).toBeNull();
    });

    it("fails open (no throw) on a corrupt response body and evicts it", async () => {
      const { cache, store } = makeFakeCache();
      const corrupt: VercelCacheReadDebugEvent[] = [];
      const s = new VercelCacheStore({
        cache,
        debug: (e) => corrupt.push(e),
      });
      await s.putResponse("doc:k", new Response("hello"), 60, 300);
      // Corrupt the stored base64 body in place; decoding it would otherwise
      // throw InvalidCharacterError out of getResponse (a fail-open violation).
      const entry = [...store.values()].find(
        (e) =>
          e.value != null &&
          typeof e.value === "object" &&
          "b" in (e.value as object),
      );
      (entry!.value as { b: string }).b = "%%%not-base64%%%";

      await expect(s.getResponse("doc:k")).resolves.toBeNull();
      expect(corrupt.at(-1)).toMatchObject({
        op: "getResponse",
        outcome: "corrupt",
      });
      // Evicted: a subsequent read is a clean miss, not another decode attempt.
      expect(await s.getResponse("doc:k")).toBeNull();
    });

    it("emits a getResponse debug event on every read", async () => {
      const { cache } = makeFakeCache();
      const events: VercelCacheReadDebugEvent[] = [];
      const s = new VercelCacheStore({ cache, debug: (e) => events.push(e) });
      await s.getResponse("doc:k"); // miss
      await s.putResponse("doc:k", new Response("x"), 60, 300);
      await s.getResponse("doc:k"); // fresh
      expect(events.map((e) => [e.op, e.outcome])).toEqual([
        ["getResponse", "miss"],
        ["getResponse", "fresh"],
      ]);
    });
  });

  describe("keyspace isolation", () => {
    it("namespaces by version so a deploy bump misses prior entries", async () => {
      const { cache } = makeFakeCache();
      const a = new VercelCacheStore({ cache, version: "buildA" });
      const b = new VercelCacheStore({ cache, version: "buildB" });
      await a.set("k", segment(), 60, 300);
      expect(await a.get("k")).not.toBeNull();
      expect(await b.get("k")).toBeNull();
    });

    it("keeps segment, item, and response families from colliding", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await s.set("same", segment(), 60, 300);
      await s.setItem("same", "item-value", { ttl: 60 });
      await s.putResponse("same", new Response("resp"), 60);
      expect((await s.get("same"))?.data.segments).toEqual([]);
      expect((await s.getItem("same"))?.value).toBe("item-value");
      expect(await (await s.getResponse("same"))?.response.text()).toBe("resp");
    });
  });
});
