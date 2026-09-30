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
import {
  createRequestContext,
  runWithRequestContext,
} from "../../../server/request-context.js";
import { createMetricsStore } from "../../../router/metrics.js";
import {
  executionStart,
  predatesInvalidation,
  revalidateTag,
} from "../../tag-invalidation.js";

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

/** A request context whose app store is `store`. */
function requestFor(store: VercelCacheStore) {
  return createRequestContext({
    env: {},
    request: new Request("https://example.com/"),
    url: new URL("https://example.com/"),
    variables: {},
    cacheStore: store,
  });
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
      const hit = okHit(await s.get("k"));
      expect(hit).not.toBeNull();
      expect(hit?.shouldRevalidate).toBe(false);
      expect(hit?.data.segments).toEqual([]);
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
      expect(okHit(await s.get("k"))?.shouldRevalidate).toBe(false);

      vi.setSystemTime(new Date(T0 + 120_000));
      expect(okHit(await s.get("k"))?.shouldRevalidate).toBe(true);

      vi.setSystemTime(new Date(T0 + 400_000));
      expect(okHit(await s.get("k"))).toBeNull();
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
      expect(okHit(await s.get("k"))?.shouldRevalidate).toBe(true);
      await Promise.all(pending); // let the re-stamp settle

      // Same instant: staleAt was pushed forward, so this read is fresh again.
      expect(okHit(await s.get("k"))?.shouldRevalidate).toBe(false);
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

    // #977: a page's writes finish together and share tags; each gate read
    // its own tm marker.
    it("the write gate shares one tm marker read among concurrent gates, and a later gate reads again", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      const getSpy = vi.spyOn(cache, "get");
      const markerReads = () =>
        getSpy.mock.calls.filter(([key]) => String(key).includes("hot")).length;

      await runWithRequestContext(requestFor(s), async () => {
        const start = executionStart();
        await Promise.all(
          Array.from({ length: 5 }, () =>
            predatesInvalidation(s, ["hot"], start),
          ),
        );
        expect(markerReads()).toBe(1);
        for (let i = 0; i < 3; i++) {
          await predatesInvalidation(s, ["hot"], start);
        }
        expect(markerReads()).toBe(4);
      });
    });

    // #977: the write gate fails closed; other callers stay fail-open.
    it("the write gate counts a tm marker read that fails as an invalidation", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      const get = cache.get.bind(cache);
      vi.spyOn(cache, "get").mockImplementation((key) =>
        String(key).includes("unread")
          ? Promise.reject(new Error("runtime cache down"))
          : get(key),
      );

      await runWithRequestContext(requestFor(s), async () => {
        const start = executionStart();
        expect(await predatesInvalidation(s, ["unread"], start)).toBe(true);
        expect(await s.isTagsInvalidatedSince(["unread"], start.at)).toBe(
          false,
        );
      });
    });

    // #977: a gate read made during the capture must not answer the
    // capture's putShell: another instance's expireTag() in between has to
    // reject the shell.
    it("putShell rejects a shell invalidated after a gate read made during its capture", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      const otherInstance = new VercelCacheStore({ cache });

      await runWithRequestContext(requestFor(s), async () => {
        const createdAt = Date.now();
        vi.advanceTimersByTime(10);
        // A "use cache" write during the capture: its gate reads the marker.
        expect(
          await predatesInvalidation(s, ["shell-tag"], executionStart()),
        ).toBe(false);
        vi.advanceTimersByTime(10);
        await otherInstance.invalidateTags(["shell-tag"]);
        vi.advanceTimersByTime(10);

        expect(
          await s.putShell("k", shellEntry({ createdAt }), 60, 300, [
            "shell-tag",
          ]),
        ).toBe("invalidated");
      });
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
      await s.putShell("k", entry, 60, 300);
      const hit = await s.getShell("k");
      expect(hit).not.toBeNull();
      expect(hit?.entry).toEqual(entry);
      expect(hit?.shouldRevalidate).toBe(false);
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

    it("round-trips the replay fields (docKey, navigationOnly)", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await s.putShell(
        "k",
        shellEntry({ docKey: "doc:host/p", navigationOnly: true }),
        60,
        300,
      );
      const entry = (await s.getShell("k"))?.entry;
      expect(entry?.docKey).toBe("doc:host/p");
      expect(entry?.navigationOnly).toBe(true);
    });

    it("declares its shell entry limit below the item cap (base64 prelude)", () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache, maxItemBytes: 4000 });
      expect(s.maxShellEntryBytes).toBe(3000);
    });

    it("round-trips a slim navigationOnly entry (no document half)", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      const slim = shellEntry({
        navigationOnly: true,
        docKey: "doc:localhost/p",
      });
      delete slim.prelude;
      delete slim.postponed;
      await s.putShell("k", slim, 60, 300);
      const entry = (await s.getShell("k"))?.entry;
      expect(entry?.navigationOnly).toBe(true);
      expect(entry?.docKey).toBe("doc:localhost/p");
      // asShellEnvelope accepts the absent document half only under `no`;
      // nothing re-materializes it on the way out.
      expect(entry?.prelude).toBeUndefined();
      expect(entry?.postponed).toBeUndefined();
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

    it("surfaces shouldRevalidate when stale, then expires after ttl+swr", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await s.putShell("k", shellEntry(), 60, 300);

      vi.setSystemTime(new Date(T0 + 30_000));
      expect((await s.getShell("k"))?.shouldRevalidate).toBe(false);

      vi.setSystemTime(new Date(T0 + 120_000));
      expect((await s.getShell("k"))?.shouldRevalidate).toBe(true);

      vi.setSystemTime(new Date(T0 + 400_000));
      expect(await s.getShell("k")).toBeNull();
    });

    it("reports a passive stale read without claiming the revalidation lock", async () => {
      const { cache, store } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await s.putShell("k", shellEntry(), 60, 300);

      vi.setSystemTime(new Date(T0 + 120_000));
      expect(
        (await s.getShell("k", { claimRevalidation: false }))?.shouldRevalidate,
      ).toBe(true);
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
      expect(await s.putShell("k", captured, 60, 300, ["home"])).toBe(
        "invalidated",
      );

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
      await s.putShell(
        "k",
        shellEntry({ prelude: btoa("x".repeat(500)) }),
        60,
        300,
      );
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

  // Issue #941, decision 1: a fresh shell read is kept per cache handle for
  // memo.shellMs; the tag-marker check still runs on every read.
  describe("shell memo", () => {
    /** Reads of the shell record itself (not tag markers or locks). */
    function countShellReads(cache: VercelRuntimeCache): () => number {
      const get = vi.spyOn(cache, "get");
      return () => get.mock.calls.filter(([key]) => key === "rg:h:k").length;
    }

    it("serves a repeat read within the window without reading the cache", async () => {
      const { cache } = makeFakeCache();
      const events: VercelCacheReadDebugEvent[] = [];
      const s = new VercelCacheStore({ cache, debug: (e) => events.push(e) });
      const entry = shellEntry();
      await s.putShell("k", entry, 60, 300);
      const reads = countShellReads(cache);

      expect((await s.getShell("k"))?.entry).toEqual(entry);
      const hit = await s.getShell("k");
      expect(hit?.entry).toEqual(entry);
      expect(hit?.shouldRevalidate).toBe(false);
      expect(reads()).toBe(1);
      expect(events.map((e) => e.outcome)).toEqual(["fresh", "memo-hit"]);
    });

    it("is shared by store instances over one cache handle", async () => {
      const { cache } = makeFakeCache();
      await new VercelCacheStore({ cache }).putShell(
        "k",
        shellEntry(),
        60,
        300,
      );
      const reads = countShellReads(cache);
      await new VercelCacheStore({ cache }).getShell("k");
      await new VercelCacheStore({ cache }).getShell("k");
      expect(reads()).toBe(1);
    });

    it("reads the cache again once the window has passed", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache, memo: { shellMs: 1000 } });
      await s.putShell("k", shellEntry(), 60, 300);
      const reads = countShellReads(cache);
      await s.getShell("k");
      vi.setSystemTime(new Date(T0 + 999));
      await s.getShell("k");
      expect(reads()).toBe(1);
      vi.setSystemTime(new Date(T0 + 1000));
      await s.getShell("k");
      expect(reads()).toBe(2);
    });

    it("does not keep a stale read", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await s.putShell("k", shellEntry(), 60, 300);
      vi.setSystemTime(new Date(T0 + 120_000));
      const reads = countShellReads(cache);
      const passive = { claimRevalidation: false };
      expect((await s.getShell("k", passive))?.shouldRevalidate).toBe(true);
      expect((await s.getShell("k", passive))?.shouldRevalidate).toBe(true);
      expect(reads()).toBe(2);
    });

    it("stops serving a memoized shell once it turns stale", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache, memo: { shellMs: 5000 } });
      await s.putShell("k", shellEntry(), 1, 300);
      await s.getShell("k");
      vi.setSystemTime(new Date(T0 + 1001));
      expect((await s.getShell("k"))?.shouldRevalidate).toBe(true);
    });

    it("evicts the least recently used shell past memo.shellMaxBytes", async () => {
      const { cache } = makeFakeCache();
      const one = JSON.stringify(
        (await (async () => {
          const probe = makeFakeCache();
          await new VercelCacheStore({ cache: probe.cache }).putShell(
            "k",
            shellEntry(),
            60,
            300,
          );
          return probe.store.get("rg:h:k")?.value;
        })()) ?? null,
      ).length;
      // Room for one shell record, not two.
      const s = new VercelCacheStore({
        cache,
        memo: { shellMaxBytes: Math.floor(one * 1.5) },
      });
      await s.putShell("k", shellEntry(), 60, 300);
      await s.putShell("other", shellEntry(), 60, 300);
      const reads = countShellReads(cache);
      await s.getShell("k");
      await s.getShell("other");
      await s.getShell("k");
      expect(reads()).toBe(2);
    });

    it("a newer capture from another instance is served once the window passes", async () => {
      const shared = makeFakeCache();
      // Two processes: separate handles over one backing cache.
      const a = new VercelCacheStore({ cache: { ...shared.cache } });
      const b = new VercelCacheStore({ cache: { ...shared.cache } });
      await a.putShell("k", shellEntry({ prelude: "old" }), 60, 300);
      expect((await b.getShell("k"))?.entry.prelude).toBe("old");

      vi.setSystemTime(new Date(T0 + 500));
      await a.putShell(
        "k",
        shellEntry({ prelude: "new", createdAt: T0 + 500 }),
        60,
        300,
      );
      expect((await b.getShell("k"))?.entry.prelude).toBe("old");
      vi.setSystemTime(new Date(T0 + 2000));
      expect((await b.getShell("k"))?.entry.prelude).toBe("new");
    });

    // Both memos in another instance can predate an invalidation; the
    // mutating user's next request carries the fresh-reads cookie and reads
    // past them (the isolate memo contract suite covers the SWR path).
    it("an invalidateTags in another instance: a request with the fresh-reads cookie misses at once", async () => {
      const shared = makeFakeCache();
      const a = new VercelCacheStore({ cache: { ...shared.cache } });
      const b = new VercelCacheStore({ cache: { ...shared.cache } });
      await a.putShell("k", shellEntry(), 60, 300, ["home"]);
      expect(await b.getShell("k")).not.toBeNull();

      vi.setSystemTime(new Date(T0 + 100));
      await a.invalidateTags(["home"]);
      expect(await b.getShell("k")).not.toBeNull();
      const request = new Request("https://test.internal/p", {
        headers: { cookie: "rango-state-fresh=1" },
      });
      const ctx = createRequestContext({
        env: {},
        request,
        url: new URL(request.url),
        variables: {},
        stateCookieName: "rango-state_router_0",
      });
      expect(
        await runWithRequestContext(ctx, () => b.getShell("k")),
      ).toBeNull();
    });

    // expireTag alone (a platform purge that skipped rango's invalidateTags)
    // deletes the entry but writes no tm markers, so a memo hit cannot see it:
    // the memoized shell serves until the window passes. updateTag and
    // revalidateTag go through invalidateTags and are rejected at once (above).
    it("a bare platform expireTag is honored once the window passes", async () => {
      const shared = makeFakeCache();
      const s = new VercelCacheStore({
        cache: shared.cache,
        memo: { shellMs: 1000 },
      });
      await s.putShell("k", shellEntry(), 60, 300, ["home"]);
      expect(await s.getShell("k")).not.toBeNull();

      await shared.cache.expireTag("home");
      expect(shared.store.has("rg:h:k")).toBe(false);
      expect(await s.getShell("k")).not.toBeNull();
      vi.setSystemTime(new Date(T0 + 1000));
      expect(await s.getShell("k")).toBeNull();
    });

    it("a memo hit keeps the stored pruned snapshot and prunedRecords", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      const snapshot: ShellCacheEntry["snapshot"] = [
        { family: "item", key: "use-cache:kept", value: { value: "KEPT" } },
      ];
      await s.putShell(
        "k",
        shellEntry({ snapshot, prunedRecords: "item:4" }),
        60,
        300,
      );
      const reads = countShellReads(cache);
      expect((await s.getShell("k"))!.entry.prunedRecords).toBe("item:4");
      const hit = await s.getShell("k");
      expect(reads()).toBe(1);
      expect(hit!.entry.prunedRecords).toBe("item:4");
      expect(hit!.entry.snapshot).toEqual(snapshot);
    });

    it("dropShellMemo sends the next read to the runtime cache", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await s.putShell("k", shellEntry(), 60, 300);
      const reads = countShellReads(cache);
      await s.getShell("k");
      await s.getShell("k");
      expect(reads()).toBe(1);
      s.dropShellMemo("k");
      await s.getShell("k");
      expect(reads()).toBe(2);
    });

    // The race KV-less purge-mode CFCacheStore had (a read during the
    // invalidation memoizes the shell again after invalidateTags dropped it)
    // cannot leak here: every memo hit reads the tm markers, which land
    // before invalidateTags resolves.
    it("a read while invalidateTags writes its markers is rejected on its next hit", async () => {
      const shared = makeFakeCache();
      const s = new VercelCacheStore({ cache: shared.cache });
      await s.putShell("k", shellEntry(), 60, 300, ["home"]);
      vi.setSystemTime(new Date(T0 + 100));
      const set = shared.cache.set.bind(shared.cache);
      let releaseMarkers!: () => void;
      const markersHeld = new Promise<void>((resolve) => {
        releaseMarkers = resolve;
      });
      vi.spyOn(shared.cache, "set").mockImplementation(
        async (key, value, options) => {
          if (key.startsWith("rg:tm:")) await markersHeld;
          return set(key, value, options);
        },
      );
      const reads = countShellReads(shared.cache);

      const invalidation = s.invalidateTags(["home"]);
      // Served and memoized: neither the markers nor expireTag have landed.
      expect(await s.getShell("k")).not.toBeNull();
      expect(await s.getShell("k")).not.toBeNull();
      expect(reads()).toBe(1);
      releaseMarkers();
      await invalidation;
      expect(await s.getShell("k")).toBeNull();
    });

    it("a read while expireTag is in flight misses (the markers landed first)", async () => {
      const shared = makeFakeCache();
      const s = new VercelCacheStore({ cache: shared.cache });
      await s.putShell("k", shellEntry(), 60, 300, ["home"]);
      await s.getShell("k");
      vi.setSystemTime(new Date(T0 + 100));
      const expireTag = shared.cache.expireTag.bind(shared.cache);
      let releaseExpire!: () => void;
      const expireHeld = new Promise<void>((resolve) => {
        releaseExpire = resolve;
      });
      vi.spyOn(shared.cache, "expireTag").mockImplementation(async (tag) => {
        await expireHeld;
        return expireTag(tag);
      });

      const invalidation = s.invalidateTags(["home"]);
      await vi.waitFor(() => expect(shared.cache.expireTag).toHaveBeenCalled());
      expect(shared.store.has("rg:h:k")).toBe(true);
      expect(await s.getShell("k")).toBeNull();
      releaseExpire();
      await invalidation;
      expect(await s.getShell("k")).toBeNull();
    });
  });

  // The document serve path's read: the prelude decoded in the store, once
  // per memoized shell, and debugPerformance stats when the request collects
  // them (rsc-rendering.ts recordShellReadStats).
  describe("readShellDocument", () => {
    function withMetrics<T>(fn: () => Promise<T>): Promise<T> {
      const ctx = createRequestContext({
        env: {},
        request: new Request("https://test.internal/p"),
        url: new URL("https://test.internal/p"),
        variables: {},
      });
      ctx._metricsStore = createMetricsStore(true);
      return runWithRequestContext(ctx, fn);
    }

    it("returns the decoded prelude, and the entry without prelude or snapshot", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      const snapshot: ShellCacheEntry["snapshot"] = [
        { family: "item", key: "use-cache:x", value: { value: "PINNED" } },
      ];
      await s.putShell("k", shellEntry({ snapshot }), 60, 300);
      const read = await s.readShellDocument("k");
      expect(new TextDecoder().decode(read!.prelude)).toBe(
        "<html><body>SHELL</body></html>",
      );
      expect("prelude" in read!.entry).toBe(false);
      expect("snapshot" in read!.entry).toBe(false);
      expect(read!.entry.postponed).toBe(JSON.stringify({ hole: 1 }));
      expect(await read!.snapshot).toEqual(snapshot);
      expect("stats" in read!).toBe(false);
    });

    // Hinted tags (remembered from the last read/write, or the route's
    // static ppr.tags) start their tm-marker reads alongside the entry read.
    it("a hinted read starts the marker read before the entry read resolves", async () => {
      vi.useRealTimers();
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({
        cache,
        memo: { shellMs: 0, markerFreshMs: 0 },
      });
      await s.putShell("k", shellEntry(), 60, 300, ["home"]);
      let entryResolved = false;
      let markerReadBeforeEntry = false;
      const get = cache.get.bind(cache);
      vi.spyOn(cache, "get").mockImplementation(async (key) => {
        if (key === "rg:tm:home" && !entryResolved) {
          markerReadBeforeEntry = true;
        }
        if (key === "rg:h:k") {
          await new Promise((resolve) => setTimeout(resolve, 20));
          const value = await get(key);
          entryResolved = true;
          return value;
        }
        return get(key);
      });
      expect(await s.readShellDocument("k")).not.toBeNull();
      expect(markerReadBeforeEntry).toBe(true);
    });

    it("a wrong hint still rejects a shell invalidated under an unhinted tag", async () => {
      const { cache } = makeFakeCache();
      const writer = new VercelCacheStore({ cache: { ...cache } });
      await writer.putShell("k", shellEntry(), 60, 300, ["b"]);
      // A second handle: no remembered hint, only the (wrong) route tag.
      const s = new VercelCacheStore({ cache: { ...cache } });
      vi.setSystemTime(new Date(T0 + 100));
      await writer.invalidateTags(["b"]);
      expect(await s.readShellDocument("k", { tagHints: ["a"] })).toBeNull();
    });

    it("decodes a memoized shell's prelude once", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      const entry = shellEntry();
      await s.putShell("k", entry, 60, 300);
      const atob = vi.spyOn(globalThis, "atob");
      try {
        await s.readShellDocument("k");
        await s.readShellDocument("k");
        await s.readShellDocument("k");
        expect(
          atob.mock.calls.filter(([b64]) => b64 === entry.prelude).length,
        ).toBe(1);
      } finally {
        atob.mockRestore();
      }
    });

    it("evicts and misses a shell whose prelude does not decode", async () => {
      const { cache, store } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await s.putShell(
        "k",
        shellEntry({ prelude: "%%%not-base64%%%" }),
        60,
        300,
      );
      expect(await s.readShellDocument("k")).toBeNull();
      expect(store.has("rg:h:k")).toBe(false);
      expect(consoleError).toHaveBeenCalled();
      expect(await s.readShellDocument("k")).toBeNull();
    });

    it("reports the store read, then the memo hit, with a serial marker read", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await s.putShell("k", shellEntry(), 60, 300, ["home"]);
      const first = await withMetrics(() => s.readShellDocument("k"));
      expect(first!.stats).toMatchObject({
        tier: "store",
        memo: { hit: false },
        tags: 1,
        markerSerial: true,
        preludeBytes: "<html><body>SHELL</body></html>".length,
      });
      expect(first!.stats!.matchMs).toBeGreaterThanOrEqual(0);
      expect(first!.stats!.markerMs).toBeGreaterThanOrEqual(0);
      const second = await withMetrics(() => s.readShellDocument("k"));
      expect(second!.stats).toMatchObject({
        tier: "memo",
        memo: { hit: true },
        tags: 1,
        markerSerial: true,
      });
      expect(second!.stats!.matchMs).toBeUndefined();
    });

    it("counts the decoded prelude against the memo budget", async () => {
      const { cache, store } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await s.putShell("k", shellEntry(), 60, 300);
      await withMetrics(() => s.readShellDocument("k"));
      const second = await withMetrics(() => s.readShellDocument("k"));
      const record = store.get("rg:h:k")!.value as string;
      expect(second!.stats!.memo).toEqual({
        hit: true,
        bytes: record.length + "<html><body>SHELL</body></html>".length,
      });
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
      expect((await s.getItem("fn"))?.shouldRevalidate).toBe(false);
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
      expect((await s.getItem("fn"))?.shouldRevalidate).toBe(true);
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
      expect((await s.getItem("fn"))?.shouldRevalidate).toBe(true);
      await Promise.all(pending);

      // Same instant, still stale, but the lock is held -> served as fresh.
      expect((await s.getItem("fn"))?.shouldRevalidate).toBe(false);
    });
  });

  // Issue #973: revalidateTag() does not wait for the tm marker writes or
  // expireTag, so the request that ran it read the entries its invalidation
  // covers until the platform deleted them.
  describe("revalidateTag: the invalidating request reads its own writes (#973)", () => {
    function requestWith(store: VercelCacheStore) {
      return createRequestContext({
        env: {},
        request: new Request("https://test.internal/p"),
        url: new URL("https://test.internal/p"),
        variables: {},
        cacheStore: store,
      });
    }

    /** Park the tm marker writes and expireTag until release is called. */
    function holdInvalidation(cache: VercelRuntimeCache): () => void {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const set = cache.set.bind(cache);
      const expireTag = cache.expireTag.bind(cache);
      vi.spyOn(cache, "set").mockImplementation(async (key, value, options) => {
        if (key.startsWith("rg:tm:")) await held;
        return set(key, value, options);
      });
      vi.spyOn(cache, "expireTag").mockImplementation(async (tag) => {
        await held;
        return expireTag(tag);
      });
      return release;
    }

    async function seed(s: VercelCacheStore): Promise<void> {
      await s.setItem("item", "v1", { ttl: 60, tags: ["home"] });
      await s.set("seg", segment(["home"]), 60, 300);
      await s.putResponse("res", new Response("r1"), 60, 300, ["home"]);
      await s.setItem("other", "v1", { ttl: 60, tags: ["unrelated"] });
      vi.setSystemTime(new Date(T0 + 100));
    }

    it.each([
      ["with no prior read", false],
      ["after a prior read", true],
    ])(
      "segment, item and response reads miss while expireTag is in flight (%s)",
      async (_label, priorRead) => {
        const { cache } = makeFakeCache();
        const s = new VercelCacheStore({ cache });
        await seed(s);
        const release = holdInvalidation(cache);
        const req = requestWith(s);

        await runWithRequestContext(req, async () => {
          if (priorRead) expect(await s.getItem("item")).not.toBeNull();
          revalidateTag("home");
          expect(await s.getItem("item")).toBeNull();
          expect(okHit(await s.get("seg"))).toBeNull();
          expect(await s.getResponse("res")).toBeNull();
          expect(await s.getItem("other")).not.toBeNull();
        });

        release();
        await Promise.all(req._pendingBackgroundTasks ?? []);
        expect(await s.getItem("item")).toBeNull();
      },
    );

    it("an entry the request writes after its invalidation is served", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await seed(s);
      const release = holdInvalidation(cache);

      await runWithRequestContext(requestWith(s), async () => {
        revalidateTag("home");
        vi.setSystemTime(new Date(T0 + 200));
        await s.setItem("item", "v2", { ttl: 60, tags: ["home"] });
        expect((await s.getItem("item"))?.value).toBe("v2");
      });
      release();
    });

    // `>=`, as the marker checks: an entry stamped in the invalidation's
    // millisecond may hold a value computed before it, so it misses. A false
    // miss, never a stale read.
    it("an entry written in the same millisecond as the invalidation misses", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await seed(s);
      const release = holdInvalidation(cache);

      await runWithRequestContext(requestWith(s), async () => {
        revalidateTag("home");
        await s.setItem("item", "v2", { ttl: 60, tags: ["home"] });
        expect(await s.getItem("item")).toBeNull();
      });
      release();
    });

    it("an entry written before the ta stamp existed counts as older and misses", async () => {
      const { cache, store } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await seed(s);
      for (const key of ["rg:i:item", "rg:s:seg", "rg:r:res"]) {
        const entry = store.get(key)!;
        const envelope = JSON.parse(entry.value as string) as { ta?: number };
        expect(envelope.ta).toBe(T0);
        delete envelope.ta;
        entry.value = JSON.stringify(envelope);
      }
      const release = holdInvalidation(cache);

      await runWithRequestContext(requestWith(s), async () => {
        revalidateTag("home");
        expect(await s.getItem("item")).toBeNull();
        expect(okHit(await s.get("seg"))).toBeNull();
        expect(await s.getResponse("res")).toBeNull();
      });
      release();
    });

    it("a context derived from the request reads its mask, and a mask it sets reaches the request", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await seed(s);
      const release = holdInvalidation(cache);
      const req = requestWith(s);
      const derived = () => Object.create(req) as typeof req;

      runWithRequestContext(req, () => revalidateTag("home"));
      await runWithRequestContext(derived(), async () => {
        expect(await s.getItem("item")).toBeNull();
        revalidateTag("unrelated");
      });
      await runWithRequestContext(req, async () => {
        expect(await s.getItem("other")).toBeNull();
      });
      release();
    });

    // A marker read in flight when the request invalidates the tag resolves
    // to the marker before the invalidation: the mask is checked again after
    // the read, as CFCacheStore.isGloballyInvalidated does.
    it("a shell read and the shell write gate whose marker read was in flight when it ran see it", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await s.putShell("k", shellEntry(), 60, 300, ["home"]);
      vi.setSystemTime(new Date(T0 + 100));
      let releaseMarkers!: () => void;
      const markersHeld = new Promise<void>((r) => (releaseMarkers = r));
      let markerReads = 0;
      let markerReadStarted!: () => void;
      const started = new Promise<void>((r) => (markerReadStarted = r));
      const get = cache.get.bind(cache);
      vi.spyOn(cache, "get").mockImplementation(async (key) => {
        if (key.startsWith("rg:tm:")) {
          if (++markerReads === 2) markerReadStarted();
          await markersHeld;
        }
        return get(key);
      });
      const release = holdInvalidation(cache);

      await runWithRequestContext(requestWith(s), async () => {
        const gate = s.isTagsInvalidatedSince(["home"], T0);
        const shell = s.getShell("k");
        await started;
        revalidateTag("home");
        releaseMarkers();
        expect(await gate).toBe(true);
        expect(await shell).toBeNull();
      });
      release();
    });

    it("a shell read and the shell write gate see it after a memoized marker read", async () => {
      const { cache } = makeFakeCache();
      const s = new VercelCacheStore({ cache });
      await s.putShell("k", shellEntry(), 60, 300, ["home"]);
      // Memoizes the shell and its absent tm marker for this process.
      expect(await s.getShell("k")).not.toBeNull();
      vi.setSystemTime(new Date(T0 + 100));
      const release = holdInvalidation(cache);

      await runWithRequestContext(requestWith(s), async () => {
        revalidateTag("home");
        expect(await s.getShell("k")).toBeNull();
        expect(await s.readShellDocument("k")).toBeNull();
        expect(await s.isTagsInvalidatedSince(["home"], T0)).toBe(true);
      });
      release();
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
    snapshot: [],
    ...overrides,
  };
}
