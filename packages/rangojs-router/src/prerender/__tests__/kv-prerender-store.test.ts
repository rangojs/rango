import { describe, it, expect } from "vitest";
import { createKVPrerenderStore } from "../cloudflare.js";
import { serializePrerenderKey, type PrerenderKey } from "../writable-store.js";
import { isStoredEntryStale } from "../writable-store.js";
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
    buildId: "b1",
    routeName: "products.detail",
    paramHash: "abc12345",
    ...over,
  };
}

describe("createKVPrerenderStore", () => {
  it("round-trips set -> get and stores under the design key", async () => {
    const kv = fakeKV();
    const store = createKVPrerenderStore(kv);
    await store.set(key(), entry, { params: { id: "42" }, ttl: 60 });
    expect(kv.map.has("prerender:r1:b1:products.detail:abc12345")).toBe(true);
    const got = await store.get(key(), { params: { id: "42" } });
    expect(got?.entry.handles).toBe("h");
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
    await store.set(key(), entry, { params: { id: "42" }, ttl: 60 });
    expect(putCalls.every((c) => c.opts === undefined)).toBe(true);
  });

  it("verifies params on read (collision guard)", async () => {
    const kv = fakeKV();
    const store = createKVPrerenderStore(kv);
    await store.set(key(), entry, { params: { id: "42" } });
    expect(await store.get(key(), { params: { id: "42" } })).not.toBeNull();
    expect(await store.get(key(), { params: { id: "99" } })).toBeNull();
  });

  it("scopes reads to the current buildId", async () => {
    const kv = fakeKV();
    const store = createKVPrerenderStore(kv);
    await store.set(key({ buildId: "old" }), entry, { params: { id: "42" } });
    expect(
      await store.get(key({ buildId: "new" }), { params: { id: "42" } }),
    ).toBeNull();
  });

  it("returns null for a corrupt stored value", async () => {
    const kv = fakeKV();
    kv.map.set(serializePrerenderKey(key()), "{not json");
    const store = createKVPrerenderStore(kv);
    expect(await store.get(key(), { params: { id: "42" } })).toBeNull();
  });

  it("returns null (not a crash) for parseable-but-malformed values", async () => {
    const store = createKVPrerenderStore(fakeKVWith("null"));
    expect(await store.get(key(), { params: { id: "42" } })).toBeNull();
    const store2 = createKVPrerenderStore(fakeKVWith(JSON.stringify({ v: 1 })));
    expect(await store2.get(key(), { params: { id: "42" } })).toBeNull();
    const store3 = createKVPrerenderStore(
      fakeKVWith(JSON.stringify({ v: 1, meta: null })),
    );
    expect(await store3.get(key(), { params: { id: "42" } })).toBeNull();
  });

  it("marks an entry stale (not deleted) when a tag marker is newer", async () => {
    let now = 1000;
    const kv = fakeKV();
    const store = createKVPrerenderStore(kv, { now: () => now });
    await store.set(key(), entry, {
      params: { id: "42" },
      ttl: 3600,
      tags: ["product:42"],
    });
    now = 2000;
    await store.invalidateTags!(["product:42"]);
    const got = await store.get(key(), { params: { id: "42" } });
    // Still present (mark-stale, not delete), and now stale.
    expect(got).not.toBeNull();
    expect(isStoredEntryStale(got!, 2000)).toBe(true);
    expect(kv.map.has(serializePrerenderKey(key()))).toBe(true);
  });

  it("leaves an entry written after the invalidation fresh", async () => {
    let now = 1000;
    const kv = fakeKV();
    const store = createKVPrerenderStore(kv, { now: () => now });
    await store.invalidateTags!(["product:42"]); // marker = 1000
    now = 2000;
    await store.set(key(), entry, {
      params: { id: "42" },
      ttl: 3600,
      tags: ["product:42"],
    }); // storedAt = 2000 > marker
    const got = await store.get(key(), { params: { id: "42" } });
    expect(isStoredEntryStale(got!, 2000)).toBe(false);
  });

  it("delete removes the entry", async () => {
    const kv = fakeKV();
    const store = createKVPrerenderStore(kv);
    await store.set(key(), entry, { params: { id: "42" } });
    await store.delete!(key());
    expect(await store.get(key(), { params: { id: "42" } })).toBeNull();
  });
});
