import { describe, it, expect } from "vitest";
import { createKVPrerenderStore } from "../cloudflare.js";
import {
  composeStoredEntry,
  composeStoredTombstone,
  isStoredEntryStale,
  isStoredEntryValidFor,
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
    await store.markStale!(["product:42"]);
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
    await store.markStale!(["product:42"]); // marker = 1000
    now = 2000;
    await store.set(
      key(),
      stored({ ttl: 3600, tags: ["product:42"] }, key(), 2000),
    ); // storedAt = 2000 > marker
    const got = await store.get(key());
    expect(isStoredEntryStale(got!, 2000)).toBe(false);
  });

  it("delete removes the entry", async () => {
    const kv = fakeKV();
    const store = createKVPrerenderStore(kv);
    await store.set(key(), stored());
    await store.delete!(key());
    expect(await store.get(key())).toBeNull();
  });

  it("persists a remove() marker as the JSON it is given, and reads no tag marker for it", async () => {
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
    const tombstone = composeStoredTombstone(
      key(),
      { tags: [], params: { id: "42" } },
      1000,
    );
    await store.set(key(), tombstone);
    // Marked after the tombstone was written: it has no tag to match.
    await store.markStale!(["product:42"]);

    gets.length = 0;
    const got = await store.get(key());
    expect(got).toEqual(tombstone);
    expect(gets).toEqual([serializePrerenderKey(key())]);
    expect(isStoredEntryValidFor(got, key(), { id: "42" })).toBe(true);
    expect(isStoredEntryStale(got!, Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it("a notFound() marker carries its route's tags: a tag marker makes it stale, as it does a page", async () => {
    let now = 1000;
    const kv = fakeKV();
    const store = createKVPrerenderStore(kv, { now: () => now });
    const tombstone = composeStoredTombstone(
      key(),
      { ttl: 3600, tags: ["product:42"], params: { id: "42" } },
      1000,
    );
    await store.set(key(), tombstone);
    expect(isStoredEntryStale((await store.get(key()))!, 2000)).toBe(false);

    now = 2000;
    await store.markStale!(["product:42"]);

    const got = await store.get(key());
    // Still the marker (mark-stale, not delete), now due a recheck.
    expect(got).toMatchObject({ v: 1, removed: true });
    expect(got).not.toHaveProperty("entry");
    expect(isStoredEntryValidFor(got, key(), { id: "42" })).toBe(true);
    expect(isStoredEntryStale(got!, 2000)).toBe(true);
  });
});
