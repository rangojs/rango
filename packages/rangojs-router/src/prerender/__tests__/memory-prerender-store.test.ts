import { describe, it, expect } from "vitest";
import { createMemoryPrerenderStore } from "../memory-prerender-store.js";
import {
  serializePrerenderKey,
  composeStoredEntry,
  isStoredEntryValidFor,
  isStoredEntryStale,
  type PrerenderKey,
} from "../writable-store.js";
import type { PrerenderEntry } from "../store.js";

const entry: PrerenderEntry = {
  segments: [{ id: "s0", encoded: "x" } as any],
  handles: "",
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

describe("serializePrerenderKey", () => {
  it("produces the design key format", () => {
    expect(serializePrerenderKey(key())).toBe(
      "prerender:r1:b1:products.detail:abc12345",
    );
  });
  it("appends :i for the intercept variant", () => {
    expect(serializePrerenderKey(key({ intercept: true }))).toBe(
      "prerender:r1:b1:products.detail:abc12345:i",
    );
  });
});

describe("composeStoredEntry / isStoredEntryStale", () => {
  it("computes staleAt from ttl and reports staleness", () => {
    const stored = composeStoredEntry(
      key(),
      entry,
      { ttl: 10, tags: ["t"], params: { id: "42" } },
      1000,
    );
    expect(stored.v).toBe(1);
    expect(stored.meta).toMatchObject({
      storedAt: 1000,
      staleAt: 11000,
      tags: ["t"],
      buildId: "b1",
      params: { id: "42" },
    });
    expect(isStoredEntryStale(stored, 10999)).toBe(false);
    expect(isStoredEntryStale(stored, 11000)).toBe(true);
  });

  it("never goes stale without a ttl", () => {
    const stored = composeStoredEntry(
      key(),
      entry,
      { params: { id: "42" } },
      1000,
    );
    expect(stored.meta.staleAt).toBeUndefined();
    expect(isStoredEntryStale(stored, Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it("ignores a NaN or negative ttl (treats as never-stale, not thrashing)", () => {
    for (const ttl of [NaN, -1, Infinity]) {
      const stored = composeStoredEntry(
        key(),
        entry,
        { ttl, params: { id: "42" } },
        1000,
      );
      expect(stored.meta.staleAt).toBeUndefined();
      expect(isStoredEntryStale(stored, Number.MAX_SAFE_INTEGER)).toBe(false);
    }
  });
});

describe("isStoredEntryValidFor — malformed durable values read as a miss", () => {
  const k = key();
  const m = { params: { id: "42" } };
  it("rejects null / non-object without throwing", () => {
    expect(isStoredEntryValidFor(null as any, k, m)).toBe(false);
    expect(isStoredEntryValidFor("null" as any, k, m)).toBe(false);
    expect(isStoredEntryValidFor(42 as any, k, m)).toBe(false);
  });
  it("rejects an envelope missing meta without throwing", () => {
    expect(isStoredEntryValidFor({ v: 1 } as any, k, m)).toBe(false);
    expect(isStoredEntryValidFor({ v: 1, meta: null } as any, k, m)).toBe(
      false,
    );
  });
  it("rejects an envelope with a malformed entry without throwing", () => {
    const meta = { buildId: k.buildId, params: m.params };
    expect(
      isStoredEntryValidFor({ v: 1, entry: null, meta } as any, k, m),
    ).toBe(false);
    expect(
      isStoredEntryValidFor(
        { v: 1, entry: { segments: null, handles: "" }, meta } as any,
        k,
        m,
      ),
    ).toBe(false);
    expect(
      isStoredEntryValidFor(
        { v: 1, entry: { segments: [], handles: null }, meta } as any,
        k,
        m,
      ),
    ).toBe(false);
  });
});

describe("isStoredEntryValidFor (verify-on-read)", () => {
  const stored = composeStoredEntry(
    key(),
    entry,
    { params: { id: "42" }, tags: [] },
    1000,
  );

  it("passes when buildId and params match", () => {
    expect(isStoredEntryValidFor(stored, key(), { params: { id: "42" } })).toBe(
      true,
    );
  });

  it("fails on a param mismatch (DJB2 collision guard)", () => {
    expect(isStoredEntryValidFor(stored, key(), { params: { id: "99" } })).toBe(
      false,
    );
  });

  it("fails on a buildId mismatch (post-deploy scoping)", () => {
    expect(
      isStoredEntryValidFor(stored, key({ buildId: "b2" }), {
        params: { id: "42" },
      }),
    ).toBe(false);
  });
});

describe("createMemoryPrerenderStore", () => {
  it("round-trips set -> get with verify-on-read", async () => {
    const store = createMemoryPrerenderStore();
    await store.set(key(), entry, { params: { id: "42" }, ttl: 60 });
    const got = await store.get(key(), { params: { id: "42" } });
    expect(got?.entry.segments.length).toBe(1);
    // Param collision: same hash key, different canonical params -> miss.
    const collision = await store.get(key(), { params: { id: "99" } });
    expect(collision).toBeNull();
  });

  it("does not serve entries from a previous buildId after a deploy", async () => {
    const store = createMemoryPrerenderStore();
    await store.set(key({ buildId: "old" }), entry, { params: { id: "42" } });
    // New deploy reads under the current buildId -> miss (build-scoped keys).
    expect(
      await store.get(key({ buildId: "new" }), { params: { id: "42" } }),
    ).toBeNull();
    // The old entry is still addressable under its own build.
    expect(
      await store.get(key({ buildId: "old" }), { params: { id: "42" } }),
    ).not.toBeNull();
  });

  it("does NOT memoize misses (a later set is visible)", async () => {
    const store = createMemoryPrerenderStore();
    expect(await store.get(key(), { params: { id: "42" } })).toBeNull();
    await store.set(key(), entry, { params: { id: "42" } });
    expect(await store.get(key(), { params: { id: "42" } })).not.toBeNull();
  });

  it("invalidateTags marks matching entries stale but keeps serving them", async () => {
    let now = 1000;
    const store = createMemoryPrerenderStore({ now: () => now });
    await store.set(key(), entry, {
      params: { id: "42" },
      ttl: 3600,
      tags: ["product:42"],
    });
    now = 2000;
    await store.invalidateTags(["product:42"]);
    const got = await store.get(key(), { params: { id: "42" } });
    // Still served (mark-stale, not delete)...
    expect(got).not.toBeNull();
    // ...but now stale, so the serve path would schedule a refresh.
    expect(isStoredEntryStale(got!, 2000)).toBe(true);
  });

  it("invalidateTags leaves non-matching entries fresh", async () => {
    const store = createMemoryPrerenderStore();
    await store.set(key(), entry, {
      params: { id: "42" },
      ttl: 3600,
      tags: ["other"],
    });
    await store.invalidateTags(["product:42"]);
    const got = await store.get(key(), { params: { id: "42" } });
    expect(isStoredEntryStale(got!, Date.now())).toBe(false);
  });

  it("delete removes the entry", async () => {
    const store = createMemoryPrerenderStore();
    await store.set(key(), entry, { params: { id: "42" } });
    await store.delete(key());
    expect(await store.get(key(), { params: { id: "42" } })).toBeNull();
    expect(store.size).toBe(0);
  });
});
