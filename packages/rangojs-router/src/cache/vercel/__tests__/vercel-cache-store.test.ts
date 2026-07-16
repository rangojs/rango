import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  VercelCacheStore,
  VERCEL_MAX_ITEM_BYTES,
  VERCEL_MAX_TAGS_PER_ITEM,
  type VercelRuntimeCache,
  type VercelCacheReadDebugEvent,
} from "../vercel-cache-store.js";
import type { CachedEntryData, ShellCacheEntry } from "../../types.js";
import {
  CACHE_READ_ERROR,
  type CacheReadError as CacheReadErrorT,
} from "../../types.js";

// get() may return CACHE_READ_ERROR (backend failure, distinct from a miss);
// these tests assert hit/miss shapes, so narrow the sentinel away up front.
function okHit(
  r: import("../../types.js").CacheGetResult | null | CacheReadErrorT,
): import("../../types.js").CacheGetResult | null {
  return r === CACHE_READ_ERROR ? null : r;
}

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
      await expect(s.set("k", segment(), 60, 300)).resolves.toEqual({
        outcome: "stored",
      });
      const hit = okHit(await s.get("k"));
      expect(hit).not.toBeNull();
      expect(hit).toMatchObject({
        freshness: "fresh",
        revalidationClaimed: false,
      });
      expect(hit?.data.segments).toEqual([]);
    });

    it("keeps ordinary writes blocking when waitUntil is available", async () => {
      const { cache } = makeFakeCache();
      const pending: Promise<unknown>[] = [];
      const s = new VercelCacheStore({
        cache,
        waitUntil: (promise) => pending.push(promise),
      });

      await expect(s.set("k", segment(), 60, 300)).resolves.toEqual({
        outcome: "stored",
      });
      expect(pending).toEqual([]);
      expect(okHit(await s.get("k"))).toMatchObject({ freshness: "fresh" });
    });

    it("returns null on a miss", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      expect(okHit(await s.get("absent"))).toBeNull();
    });

    it("delete reports success", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await s.set("k", segment(), 60);
      expect(await s.delete("k")).toBe(true);
      expect(okHit(await s.get("k"))).toBeNull();
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
      expect(okHit(await s.get("k"))).toBeNull();
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
      expect(okHit(await s.get("k"))).toMatchObject({
        freshness: "fresh",
        revalidationClaimed: false,
      });

      vi.setSystemTime(new Date(T0 + 120_000));
      expect(okHit(await s.get("k"))).toMatchObject({
        freshness: "stale",
        revalidationClaimed: true,
      });

      vi.setSystemTime(new Date(T0 + 400_000));
      expect(okHit(await s.get("k"))).toBeNull();
    });

    it("dampens the herd while preserving stale freshness", async () => {
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
      expect(okHit(await s.get("k"))).toMatchObject({
        freshness: "stale",
        revalidationClaimed: true,
      });
      await Promise.all(pending); // let the lock write settle

      // Same instant: the entry remains stale, but the existing lock guards it.
      expect(okHit(await s.get("k"))).toMatchObject({
        freshness: "stale",
        revalidationClaimed: false,
      });
    });
  });

  describe("tags", () => {
    it("invalidateTags expires tagged entries via expireTag", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await s.set("k", segment(["blog"]), 60, 300);
      expect(okHit(await s.get("k"))).not.toBeNull();
      await s.invalidateTags(["blog"]);
      expect(okHit(await s.get("k"))).toBeNull();
    });

    it("invalidateTags rejects when expireTag fails (read-your-own-writes)", async () => {
      const { cache, failExpireTag } = makeFakeCache();
      failExpireTag(() => {
        throw new Error("expireTag boom");
      });
      const s = new VercelCacheStore({ cache });
      await expect(s.invalidateTags(["x"])).rejects.toThrow("expireTag boom");
    });

    // The build-shell read-through's eviction gate (#699): the platform's
    // expireTag DELETES entries and keeps no history, so invalidateTags writes
    // its own tm-family markers and isTagsInvalidatedSince compares them
    // against a baked entry's build-time createdAt (>= — same-ms wins).
    it("isTagsInvalidatedSince: marker at or after `since` wins; absent tags are false", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      const t0 = Date.now();
      await s.invalidateTags(["home"]);
      expect(await s.isTagsInvalidatedSince(["home"], t0)).toBe(true);
      expect(await s.isTagsInvalidatedSince(["home"], t0 + 1)).toBe(false);
      expect(await s.isTagsInvalidatedSince(["absent"], 0)).toBe(false);
      expect(await s.isTagsInvalidatedSince(["absent", "home"], t0)).toBe(true);
    });

    it("tag markers survive expireTag (untagged) and live in the tm family", async () => {
      const { cache, store } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await s.invalidateTags(["home"]);
      const markerKey = [...store.keys()].find((k) => k.includes(":tm:"));
      expect(markerKey).toBeTruthy();
      expect(store.get(markerKey!)!.tags).toEqual([]);
      // Invalidating another tag must not delete the first marker.
      await s.invalidateTags(["other"]);
      expect(store.has(markerKey!)).toBe(true);
    });

    it("drops comma-bearing and over-length tags but keeps valid ones", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      const longTag = "a".repeat(300);
      await s.set("k", segment(["ok", "a,b", longTag]), 60, 300);
      // The bad tags never reached the backend, so they cannot invalidate.
      await s.invalidateTags(["a,b"]);
      expect(okHit(await s.get("k"))).not.toBeNull();
      await s.invalidateTags(["ok"]);
      expect(okHit(await s.get("k"))).toBeNull();
    });

    it("drops tags with URL metacharacters (&, #, %, ?) Vercel cannot round-trip", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await s.set(
        "k",
        segment(["ok", "sale&fall", "a#b", "x%y", "q?z"]),
        60,
        300,
      );
      // The metachar tags never reached the backend (dropped symmetrically on
      // write AND invalidate), so they cannot invalidate the entry.
      for (const bad of ["sale&fall", "a#b", "x%y", "q?z"]) {
        await s.invalidateTags([bad]);
      }
      expect(okHit(await s.get("k"))).not.toBeNull();
      // The one valid tag still invalidates.
      await s.invalidateTags(["ok"]);
      expect(okHit(await s.get("k"))).toBeNull();
    });

    it("stores the CLAMPED tag list in the item envelope (dropped tags don't resurface on a hit)", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await s.setItem("use-cache:fn", "v", { ttl: 60, tags: ["ok", "a&b"] });
      const hit = await s.getItem("use-cache:fn");
      // "a&b" was dropped on write, so it must not reappear in the hit's tags
      // (which flow into an upstream document's tag set).
      expect(hit?.tags).toEqual(["ok"]);
    });

    it("stores the CLAMPED tag list in the segment envelope too (set/get family)", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await s.set("k", segment(["ok", "a&b"]), 60, 300);
      const hit = okHit(await s.get("k"));
      // "a&b" was dropped from the backend tag index on write; it must not
      // ride back via env.d.tags into recordRequestTags (nor be re-clamped
      // with a spurious cache-write report on every stale read).
      expect(hit?.data.tags).toEqual(["ok"]);
    });

    it("clamps tags per item on write; tags beyond the cap cannot invalidate", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      const overflow = VERCEL_MAX_TAGS_PER_ITEM + 1;
      const tags = Array.from({ length: overflow }, (_, i) => `t${i}`);
      await s.set("k", segment(tags), 60, 300);
      // The (cap+1)th tag is dropped on write, so it cannot invalidate.
      await s.invalidateTags([`t${VERCEL_MAX_TAGS_PER_ITEM}`]);
      expect(okHit(await s.get("k"))).not.toBeNull();
      await s.invalidateTags(["t0"]); // kept (within the cap)
      expect(okHit(await s.get("k"))).toBeNull();
    });

    it("documents the per-item tag cap as Vercel's getCache limit (128)", () => {
      expect(VERCEL_MAX_TAGS_PER_ITEM).toBe(128);
    });
  });

  describe("size guard", () => {
    it("skips a segment write above maxItemBytes (fail-open)", async () => {
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
      await expect(s.set("k", big, 60, 300)).resolves.toEqual({
        outcome: "skipped",
        reason: "size-limit",
      });
      expect(store.has("rg:s:k")).toBe(false);
      expect(consoleError).toHaveBeenCalled();
    });

    it("returns size-limit when response and item writes are oversized", async () => {
      const { cache, store } = makeFakeCache();
      const s = new VercelCacheStore({ cache, maxItemBytes: 1 });

      await expect(
        s.putResponse("doc:k", new Response("x"), 60),
      ).resolves.toEqual({ outcome: "skipped", reason: "size-limit" });
      await expect(s.setItem("fn", "x", { ttl: 60 })).resolves.toEqual({
        outcome: "skipped",
        reason: "size-limit",
      });
      expect(store.has("rg:r:doc:k")).toBe(false);
      expect(store.has("rg:i:fn")).toBe(false);
    });

    it("returns failed when Runtime Cache rejects any value-family write", async () => {
      const { cache } = makeFakeCache();
      cache.set = vi.fn(async () => {
        throw new Error("set failed");
      });
      const s = new VercelCacheStore({ cache });

      await expect(s.set("segment", segment(), 60)).resolves.toEqual({
        outcome: "failed",
      });
      await expect(
        s.putResponse("response", new Response("x"), 60),
      ).resolves.toEqual({ outcome: "failed" });
      await expect(s.setItem("item", "x", { ttl: 60 })).resolves.toEqual({
        outcome: "failed",
      });
      await expect(s.putShell("shell", shellEntry(), 60)).resolves.toEqual({
        outcome: "failed",
      });
    });

    it("defaults the cap to 2 MB", () => {
      expect(VERCEL_MAX_ITEM_BYTES).toBe(2 * 1024 * 1024);
    });
  });

  describe('"use cache" items (getItem/setItem)', () => {
    it("round-trips a value with handles and tags", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await expect(
        s.setItem("use-cache:fn", "SERIALIZED", {
          handles: "HANDLES",
          ttl: 60,
          swr: 300,
          tags: ["t"],
        }),
      ).resolves.toEqual({ outcome: "stored" });
      const hit = await s.getItem("use-cache:fn");
      expect(hit?.value).toBe("SERIALIZED");
      expect(hit?.handles).toBe("HANDLES");
      expect(hit?.tags).toEqual(["t"]);
      expect(hit).toMatchObject({
        freshness: "fresh",
        revalidationClaimed: false,
      });
    });

    it("reports stale freshness and revalidation ownership independently", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await s.setItem("use-cache:fn", "v", { ttl: 60, swr: 300 });
      vi.setSystemTime(new Date(T0 + 120_000));
      expect(await s.getItem("use-cache:fn")).toMatchObject({
        freshness: "stale",
        revalidationClaimed: true,
      });
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
      await expect(
        s.putResponse("doc:k", res, 60, 300, ["response-tag"]),
      ).resolves.toEqual({ outcome: "stored" });
      const hit = await s.getResponse("doc:k");
      expect(hit).not.toBeNull();
      expect(hit?.response.status).toBe(201);
      expect(hit?.response.headers.get("x-custom")).toBe("1");
      expect(await hit?.response.text()).toBe("hello body");
      expect(hit).toMatchObject({
        freshness: "fresh",
        revalidationClaimed: false,
        tags: ["response-tag"],
      });
    });

    it("keeps guarded response hits stale without transferring ownership", async () => {
      const { cache } = makeFakeCache();
      const pending: Promise<unknown>[] = [];
      const s = new VercelCacheStore({
        cache,
        waitUntil: (promise) => pending.push(promise),
      });
      await s.putResponse("doc:k", new Response("x"), 60, 300);
      vi.setSystemTime(new Date(T0 + 120_000));

      expect(await s.getResponse("doc:k")).toMatchObject({
        freshness: "stale",
        revalidationClaimed: true,
      });
      await Promise.all(pending);
      expect(await s.getResponse("doc:k")).toMatchObject({
        freshness: "stale",
        revalidationClaimed: false,
      });
    });

    it("round-trips a large binary body (>32 KB spanning bytes 0-255) with no call-stack overflow", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      // 200 KB spanning every byte value 0-255 (exercises latin1 high bytes
      // 128-255) forces ~25 String.fromCharCode.apply chunks. The old encoder
      // spread up to 32,768 bytes as function arguments, which can throw
      // RangeError under stack pressure and silently degrade the write to a
      // no-op. The shared chunk-capped encoder must round-trip byte-for-byte.
      const size = 200_000;
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i++) bytes[i] = i % 256;
      await s.putResponse("doc:big", new Response(bytes), 60, 300);
      const hit = await s.getResponse("doc:big");
      expect(hit).not.toBeNull();
      const roundTripped = new Uint8Array(await hit!.response.arrayBuffer());
      expect(roundTripped.length).toBe(size);
      expect(roundTripped).toEqual(bytes);
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
      // Corrupt the stored base64 body; decoding it would otherwise throw
      // InvalidCharacterError out of getResponse (a fail-open violation). Entries
      // are stored as pre-serialized JSON strings (write() serializes once), so
      // parse, mutate `b`, and re-stringify — tolerating the legacy object shape.
      const entry = [...store.values()].find((e) => {
        const v = typeof e.value === "string" ? JSON.parse(e.value) : e.value;
        return v != null && typeof v === "object" && "b" in v;
      });
      if (typeof entry!.value === "string") {
        const env = JSON.parse(entry!.value);
        env.b = "%%%not-base64%%%";
        entry!.value = JSON.stringify(env);
      } else {
        (entry!.value as { b: string }).b = "%%%not-base64%%%";
      }

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
      vi.setSystemTime(new Date(T0 + 120_000));
      await s.getResponse("doc:k"); // stale, claims lock
      await s.getResponse("doc:k"); // stale, guarded
      expect(events.map((e) => [e.op, e.outcome])).toEqual([
        ["getResponse", "miss"],
        ["getResponse", "fresh"],
        ["getResponse", "stale"],
        ["getResponse", "stale"],
      ]);
      expect(events.slice(1)).toMatchObject([
        { freshness: "fresh", revalidationClaimed: false },
        { freshness: "stale", revalidationClaimed: true },
        { freshness: "stale", revalidationClaimed: false },
      ]);
      expect(events[1]).not.toHaveProperty("shouldRevalidate");
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
      expect(okHit(await s.get("same"))?.data.segments).toEqual([]);
      expect((await s.getItem("same"))?.value).toBe("item-value");
      expect(await (await s.getResponse("same"))?.response.text()).toBe("resp");
    });

    it("keeps the shell family (h) isolated from the other families", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await s.set("same", segment(), 60, 300);
      await s.putShell("same", shellEntry(), 60, 300);
      expect(okHit(await s.get("same"))?.data.segments).toEqual([]);
      expect((await s.getShell("same"))?.entry.prelude).toBe(
        shellEntry().prelude,
      );
    });
  });

  describe("shell family (getShell/putShell)", () => {
    it("round-trips a shell entry", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      const entry = shellEntry();
      await expect(
        s.putShell("k", entry, 60, 300, ["shell-tag"]),
      ).resolves.toEqual({ outcome: "stored" });
      const hit = await s.getShell("k");
      expect(hit).not.toBeNull();
      expect(hit?.entry).toEqual(entry);
      expect(hit).toMatchObject({
        freshness: "fresh",
        revalidationClaimed: false,
        tags: ["shell-tag"],
      });
    });

    it("round-trips a DATA-variant entry (postponed === null)", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      const entry = shellEntry({ postponed: null });
      await s.putShell("k", entry, 60, 300);
      expect((await s.getShell("k"))?.entry.postponed).toBeNull();
    });

    // The envelope cherry-picks fields, so initialTheme (theme fidelity) and the
    // capture data snapshot (HIT parity) must be explicitly carried.
    it("round-trips initialTheme and the capture data snapshot", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      const entry = shellEntry({
        initialTheme: "dark",
        snapshot: [
          {
            family: "item",
            key: "use-cache:x",
            value: { value: "CAPVAL", tags: ["t1"] },
          },
        ],
      });
      await s.putShell("k", entry, 60, 300);
      const hit = await s.getShell("k");
      expect(hit?.entry.initialTheme).toBe("dark");
      expect(hit?.entry.snapshot).toEqual(entry.snapshot);
    });

    it("round-trips replay eligibility flags", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await s.putShell(
        "k",
        shellEntry({
          handlerLiveHoles: true,
          transitionWhen: true,
          navigationOnly: true,
        }),
        60,
        300,
      );
      const entry = (await s.getShell("k"))?.entry;
      expect(entry?.handlerLiveHoles).toBe(true);
      expect(entry?.transitionWhen).toBe(true);
      expect(entry?.navigationOnly).toBe(true);
    });

    // docKey names the canonical doc segment record navigation replay
    // consumes; dropping it in either direction reads back as "no consumable
    // record" and every partial navigation reports no-segment-snapshot after
    // a store round trip (the CF envelope had exactly this bug).
    it("round-trips docKey", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await s.putShell("k", shellEntry({ docKey: "doc:localhost/p" }), 60, 300);
      expect((await s.getShell("k"))?.entry.docKey).toBe("doc:localhost/p");
    });

    it("reports freshness and revalidation ownership, then expires after ttl+swr", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await s.putShell("k", shellEntry(), 60, 300);

      vi.setSystemTime(new Date(T0 + 30_000));
      expect(await s.getShell("k")).toMatchObject({
        freshness: "fresh",
        revalidationClaimed: false,
      });

      vi.setSystemTime(new Date(T0 + 120_000));
      expect(await s.getShell("k")).toMatchObject({
        freshness: "stale",
        revalidationClaimed: true,
      });

      vi.setSystemTime(new Date(T0 + 400_000));
      expect(await s.getShell("k")).toBeNull();
    });

    it("reports a passive stale read without claiming the revalidation lock", async () => {
      const { cache, store } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await s.putShell("k", shellEntry(), 60, 300);

      vi.setSystemTime(new Date(T0 + 120_000));
      expect(await s.getShell("k", { claimRevalidation: false })).toMatchObject(
        {
          freshness: "stale",
          revalidationClaimed: false,
        },
      );
      expect(store.has("rg:h:k:lock")).toBe(false);
    });

    it("is invalidated by tag", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await s.putShell("k", shellEntry(), 60, 300, ["home"]);
      expect(await s.getShell("k")).not.toBeNull();
      await s.invalidateTags(["home"]);
      expect(await s.getShell("k")).toBeNull();
    });

    it("does not resurrect a shell captured before tag invalidation", async () => {
      const { cache, store } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      const captured = shellEntry({ createdAt: T0 });
      vi.setSystemTime(new Date(T0 + 1));
      await s.invalidateTags(["home"]);
      expect(await s.putShell("k", captured, 60, 300, ["home"])).toEqual({
        outcome: "skipped",
        reason: "invalidated-generation",
      });

      expect(await s.getShell("k")).toBeNull();
      expect(store.has("rg:h:k")).toBe(false);
    });

    it("does not delete a newer shell when an older capture is rejected", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      vi.setSystemTime(new Date(T0 + 1));
      await s.invalidateTags(["home"]);
      vi.setSystemTime(new Date(T0 + 2));
      await s.putShell(
        "k",
        shellEntry({ prelude: "new", createdAt: T0 + 2 }),
        60,
        300,
        ["home"],
      );
      await s.putShell(
        "k",
        shellEntry({ prelude: "old", createdAt: T0 }),
        60,
        300,
        ["home"],
      );

      expect((await s.getShell("k"))?.entry.prelude).toBe("new");
    });

    it("does not retain a tagged shell longer than its invalidation marker", async () => {
      const { cache, store } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      const twoYears = 2 * 365 * 24 * 60 * 60;
      await s.putShell("k", shellEntry(), twoYears, 0, ["home"]);

      expect(store.get("rg:h:k")?.expiresAt).toBe(
        T0 + 365 * 24 * 60 * 60 * 1000,
      );
    });

    it("skips a shell write above maxItemBytes (fail-open) and misses", async () => {
      const { cache, store } = makeFakeCache();
      const s = new VercelCacheStore({ cache, maxItemBytes: 100 });
      await expect(
        s.putShell(
          "k",
          shellEntry({ prelude: btoa("x".repeat(500)) }),
          60,
          300,
        ),
      ).resolves.toEqual({ outcome: "skipped", reason: "size-limit" });
      expect(store.has("rg:h:k")).toBe(false);
      expect(consoleError).toHaveBeenCalled();
      expect(await s.getShell("k")).toBeNull();
    });

    it("evicts and misses on a corrupt (non-envelope) stored value", async () => {
      const { cache, store } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      store.set("rg:h:k", {
        value: { not: "an envelope" },
        expiresAt: null,
        tags: [],
      });
      expect(await s.getShell("k")).toBeNull();
      expect(store.has("rg:h:k")).toBe(false); // self-healed
      expect(consoleError).toHaveBeenCalled();
    });
  });

  describe("serialize-once + companion-lock dampening (C6)", () => {
    it("stores new entries as pre-serialized strings (single serialization)", async () => {
      const { cache, store } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await s.setItem("fn", "v", { ttl: 60 });
      const entry = store.get("rg:i:fn")!;
      // write() serializes once and hands the platform a string.
      expect(typeof entry.value).toBe("string");
      // ...which still round-trips back to a value on read (decodeRaw parses it).
      expect((await s.getItem("fn"))?.value).toBe("v");
    });

    it("reads a legacy OBJECT-shaped item envelope (pre-serialization-change)", async () => {
      const { cache, store } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      // Plant a raw object envelope, how entries looked before write() serialized.
      store.set("rg:i:legacy", {
        value: { v: "LEGACY", s: T0 + 60_000, e: T0 + 360_000, t: ["x"] },
        expiresAt: null,
        tags: [],
      });
      const hit = await s.getItem("legacy");
      expect(hit?.value).toBe("LEGACY");
      expect(hit?.tags).toEqual(["x"]);
    });

    it("reads a legacy OBJECT-shaped segment envelope too", async () => {
      const { cache, store } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      store.set("rg:s:legacy", {
        value: {
          d: { segments: [], handles: "", expiresAt: 0 },
          s: T0 + 60_000,
          e: T0 + 360_000,
        },
        expiresAt: null,
        tags: [],
      });
      const hit = okHit(await s.get("legacy"));
      expect(hit).not.toBeNull();
      expect(hit?.data.segments).toEqual([]);
    });

    it("a fresh hit reads only the main key (no lock round trip)", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await s.setItem("fn", "v", { ttl: 60, swr: 300 });
      const getSpy = vi.spyOn(cache, "get");
      vi.setSystemTime(new Date(T0 + 10_000)); // still fresh
      expect(await s.getItem("fn")).toMatchObject({
        freshness: "fresh",
        revalidationClaimed: false,
      });
      // Exactly one read (the main key), no companion-lock read.
      expect(getSpy).toHaveBeenCalledTimes(1);
      expect(getSpy).toHaveBeenCalledWith("rg:i:fn");
    });

    it("a stale read adds exactly one lock read and writes ONLY the tiny lock", async () => {
      const { cache, store } = makeFakeCache();
      const pending: Promise<unknown>[] = [];
      const s = new VercelCacheStore({
        cache,
        waitUntil: (p) => {
          pending.push(p);
        },
      });
      await s.setItem("fn", "PAYLOAD", { ttl: 60, swr: 300 });
      const storeKey = "rg:i:fn";
      const payloadBefore = store.get(storeKey)!.value;

      const getSpy = vi.spyOn(cache, "get");
      vi.setSystemTime(new Date(T0 + 120_000));
      expect(await s.getItem("fn")).toMatchObject({
        freshness: "stale",
        revalidationClaimed: true,
      });
      await Promise.all(pending); // settle the lock write

      // Main key + companion lock = two reads.
      expect(getSpy).toHaveBeenCalledTimes(2);
      // Only the tiny lock was written; the payload envelope is untouched.
      expect(store.has(`${storeKey}:lock`)).toBe(true);
      expect(store.get(storeKey)!.value).toBe(payloadBefore);
    });

    it("the lock dampens the herd: a second stale reader does not re-trigger revalidation", async () => {
      const { cache } = makeFakeCache();
      const pending: Promise<unknown>[] = [];
      const s = new VercelCacheStore({
        cache,
        waitUntil: (p) => {
          pending.push(p);
        },
      });
      await s.setItem("fn", "v", { ttl: 60, swr: 300 });

      vi.setSystemTime(new Date(T0 + 120_000));
      // First stale reader claims the lock -> triggers revalidation.
      expect(await s.getItem("fn")).toMatchObject({
        freshness: "stale",
        revalidationClaimed: true,
      });
      await Promise.all(pending);

      // Same instant, still stale, but the lock is held by another reader.
      expect(await s.getItem("fn")).toMatchObject({
        freshness: "stale",
        revalidationClaimed: false,
      });
    });
  });
});

/** A minimal shell entry for the shell-family tests. */
function shellEntry(overrides: Partial<ShellCacheEntry> = {}): ShellCacheEntry {
  return {
    prelude: btoa("<html><body>SHELL</body></html>"),
    postponed: JSON.stringify({ hole: 1 }),
    reactVersion: "19.2.6",
    buildVersion: "build-abc",
    createdAt: T0,
    ...overrides,
  };
}
