import { describe, it, expect } from "vitest";
import { createKVPrerenderStore } from "../cloudflare.js";
import {
  composeStoredEntry,
  isStoredEntryStale,
  serializePrerenderKey,
  type PrerenderKey,
} from "../writable-store.js";
import type { PrerenderEntry } from "../store.js";
import type { KVNamespace } from "../../cache/cf/cf-cache-types.js";

function fakeKV() {
  const map = new Map<string, string>();
  const kv: KVNamespace & { map: Map<string, string> } = {
    map,
    async get(k: string) {
      return map.get(k) ?? null;
    },
    async put(k: string, v: string) {
      map.set(k, v);
    },
    async delete(k: string) {
      map.delete(k);
    },
  };
  return kv;
}

// A fake KV pre-seeded with a raw string at the default entry key.
function fakeKVWith(raw: string) {
  const kv = fakeKV();
  kv.map.set(serializePrerenderKey(key()), raw);
  return kv;
}

const entry: PrerenderEntry = {
  segments: [{ id: "s0", encoded: "x" } as any],
  handles: "h",
};

function key(over: Partial<PrerenderKey> = {}): PrerenderKey {
  return {
    routerId: "r1",
    version: "b1",
    routeName: "products.detail",
    paramHash: "abc12345",
    ...over,
  };
}

// The router-composed envelope the store persists as given.
function stored(
  over: { ttl?: number; tags?: string[] } = {},
  k: PrerenderKey = key(),
  now = 1000,
) {
  return composeStoredEntry(
    k,
    entry,
    {
      ...(over.ttl != null ? { ttl: over.ttl } : {}),
      tags: over.tags ?? [],
      params: { id: "42" },
    },
    now,
  );
}

describe("createKVPrerenderStore", () => {
  it("round-trips set -> get and stores under the design key", async () => {
    const kv = fakeKV();
    const store = createKVPrerenderStore(kv);
    await store.set(key(), stored({ ttl: 60 }));
    expect(kv.map.has("prerender:r1:b1:products.detail:abc12345")).toBe(true);
    const got = await store.get(key());
    expect(got).toEqual(stored({ ttl: 60 }));
  });

  it("writes NO KV expirationTtl (soft staleAt only)", async () => {
    const kv = fakeKV();
    const putCalls: Array<{ opts: unknown }> = [];
    const spied: KVNamespace = {
      ...kv,
      put: async (k, v, opts) => {
        putCalls.push({ opts });
        return kv.put(k, v, opts);
      },
    };
    const store = createKVPrerenderStore(spied);
    await store.set(key(), stored({ ttl: 60 }));
    expect(putCalls.every((c) => c.opts === undefined)).toBe(true);
  });

  it("keys by the full key: another version is a different entry", async () => {
    const kv = fakeKV();
    const store = createKVPrerenderStore(kv);
    await store.set(
      key({ version: "old" }),
      stored({}, key({ version: "old" })),
    );
    expect(await store.get(key({ version: "new" }))).toBeNull();
  });

  it("returns null for a corrupt stored value", async () => {
    const kv = fakeKV();
    kv.map.set(serializePrerenderKey(key()), "{not json");
    const store = createKVPrerenderStore(kv);
    expect(await store.get(key())).toBeNull();
  });

  it("returns parseable-but-malformed values without throwing (the router rejects them)", async () => {
    for (const raw of [
      "null",
      JSON.stringify({ v: 1 }),
      JSON.stringify({ v: 1, meta: null }),
    ]) {
      const store = createKVPrerenderStore(fakeKVWith(raw));
      await expect(store.get(key())).resolves.toEqual(JSON.parse(raw));
    }
  });

  it("marks an entry stale (not deleted) when a tag marker is newer", async () => {
    let now = 1000;
    const kv = fakeKV();
    const store = createKVPrerenderStore(kv, { now: () => now });
    await store.set(key(), stored({ ttl: 3600, tags: ["product:42"] }));
    now = 2000;
    await store.markStale!("r1", ["product:42"]);
    const got = await store.get(key());
    // Still present (mark-stale, not delete), and now stale.
    expect(got).not.toBeNull();
    expect(isStoredEntryStale(got!, 2000)).toBe(true);
    expect(kv.map.has(serializePrerenderKey(key()))).toBe(true);
  });

  it("skips tag-marker reads for an entry already stale", async () => {
    const kv = fakeKV();
    const gets: string[] = [];
    const spied: KVNamespace = {
      ...kv,
      get: (async (k: string) => {
        gets.push(k);
        return kv.get(k);
      }) as KVNamespace["get"],
    };
    const store = createKVPrerenderStore(spied, { now: () => 5000 });
    await store.set(key(), stored({ ttl: 1, tags: ["t"] }, key(), 1000));
    gets.length = 0;
    await store.get(key());
    expect(gets).toEqual([serializePrerenderKey(key())]);

    const fresh = createKVPrerenderStore(spied, { now: () => 1500 });
    gets.length = 0;
    await fresh.get(key());
    expect(gets).toHaveLength(2);
  });

  it("leaves an entry written after the marker fresh", async () => {
    let now = 1000;
    const kv = fakeKV();
    const store = createKVPrerenderStore(kv, { now: () => now });
    await store.markStale!("r1", ["product:42"]); // marker = 1000
    now = 2000;
    await store.set(
      key(),
      stored({ ttl: 3600, tags: ["product:42"] }, key(), 2000),
    ); // storedAt = 2000 > marker
    const got = await store.get(key());
    expect(isStoredEntryStale(got!, 2000)).toBe(false);
  });

  it("a marker written for one router does not mark another router's entry", async () => {
    let now = 1000;
    const kv = fakeKV();
    const store = createKVPrerenderStore(kv, { now: () => now });
    const a = key({ routerId: "router-a" });
    const b = key({ routerId: "router-b" });
    await store.set(a, stored({ ttl: 3600, tags: ["product:42"] }, a));
    await store.set(b, stored({ ttl: 3600, tags: ["product:42"] }, b));
    now = 2000;
    await store.markStale!("router-a", ["product:42"]);
    expect(isStoredEntryStale((await store.get(a))!, 2000)).toBe(true);
    expect(isStoredEntryStale((await store.get(b))!, 2000)).toBe(false);
  });

  it("scopes the marker key by the encoded router id, so ids and tags never run together", async () => {
    const kv = fakeKV();
    const store = createKVPrerenderStore(kv, { now: () => 1000 });
    await store.markStale!("a/b", ["c"]);
    await store.markStale!("a", ["b/c"]);
    expect([...kv.map.keys()].sort()).toEqual([
      "__rango_pr_tag__/a%2Fb/c",
      "__rango_pr_tag__/a/b/c",
    ]);
  });

  describe("tagMarkerTtl", () => {
    function spiedKV() {
      const kv = fakeKV();
      const puts: Array<{ k: string; opts: unknown }> = [];
      const spied: KVNamespace = {
        ...kv,
        put: async (k, v, opts) => {
          puts.push({ k, opts });
          return kv.put(k, v, opts);
        },
      };
      return { spied, puts };
    }

    it("writes markers with no expiry by default", async () => {
      const { spied, puts } = spiedKV();
      await createKVPrerenderStore(spied).markStale!("r1", ["t"]);
      expect(puts.map((p) => p.opts)).toEqual([undefined]);
    });

    it("passes the TTL to KV as expirationTtl, never on entries", async () => {
      const { spied, puts } = spiedKV();
      const store = createKVPrerenderStore(spied, { tagMarkerTtl: 7200 });
      await store.markStale!("r1", ["t"]);
      await store.set(key(), stored({ ttl: 60 }));
      expect(puts.map((p) => p.opts)).toEqual([
        { expirationTtl: 7200 },
        undefined,
      ]);
    });

    it("raises a value below KV's 60s floor, and ignores a non-positive or non-finite one", async () => {
      const seen: unknown[] = [];
      for (const tagMarkerTtl of [5, 0, -1, Number.NaN, Infinity]) {
        const { spied, puts } = spiedKV();
        await createKVPrerenderStore(spied, { tagMarkerTtl }).markStale!("r1", [
          "t",
        ]);
        seen.push(puts[0].opts);
      }
      expect(seen).toEqual([
        { expirationTtl: 60 },
        undefined,
        undefined,
        undefined,
        undefined,
      ]);
    });
  });

  it("delete removes the entry", async () => {
    const kv = fakeKV();
    const store = createKVPrerenderStore(kv);
    await store.set(key(), stored());
    await store.delete!(key());
    expect(await store.get(key())).toBeNull();
  });
});
