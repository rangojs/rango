import { describe, it, expect } from "vitest";
import { createMemoryPrerenderStore } from "../memory-prerender-store.js";
import {
  serializePrerenderKey,
  composeStoredEntry,
  composeStoredTombstone,
  isStoredEntryValidFor,
  isStoredEntryStale,
  lowerStoredEntryStaleAt,
  readVerifiedStoredEntry,
  type PrerenderKey,
} from "../writable-store.js";
import type { PrerenderEntry } from "../store.js";
import { paramsEqual } from "../../router/params-util.js";

const entry: PrerenderEntry = {
  segments: [{ id: "s0", encoded: "x" } as any],
  handles: "",
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

describe("serializePrerenderKey", () => {
  it("produces the design key format", () => {
    expect(serializePrerenderKey(key())).toBe(
      "prerender:r1:b1:products.detail:abc12345",
    );
  });
  it("serializes the main variant with no suffix", () => {
    expect(serializePrerenderKey(key())).not.toMatch(/:i$/);
    expect(serializePrerenderKey(key({ paramHash: "ffffffff" }))).toBe(
      "prerender:r1:b1:products.detail:ffffffff",
    );
  });
});

describe("lowerStoredEntryStaleAt / readVerifiedStoredEntry", () => {
  const params = { id: "42" };
  const make = (staleAt?: number) => {
    const e = composeStoredEntry(key(), entry, { tags: ["t"], params }, 1000);
    if (staleAt != null) e.meta.staleAt = staleAt;
    return e;
  };

  it("lowers an unset or later staleAt and keeps an earlier one", () => {
    const unset = make();
    lowerStoredEntryStaleAt(unset, 2000);
    expect(unset.meta.staleAt).toBe(2000);
    const later = make(9000);
    lowerStoredEntryStaleAt(later, 2000);
    expect(later.meta.staleAt).toBe(2000);
    const earlier = make(1500);
    lowerStoredEntryStaleAt(earlier, 2000);
    expect(earlier.meta.staleAt).toBe(1500);
  });

  it("returns a verified entry, and null for a miss, mismatch or store error", async () => {
    const store = createMemoryPrerenderStore();
    await store.set(key(), make());
    expect(await readVerifiedStoredEntry(store, key(), params)).not.toBeNull();
    expect(
      await readVerifiedStoredEntry(store, key(), { id: "43" }),
    ).toBeNull();
    expect(
      await readVerifiedStoredEntry(store, key({ paramHash: "zz" }), params),
    ).toBeNull();
    const throwing = {
      ...store,
      get: async () => {
        throw new Error("outage");
      },
    };
    expect(await readVerifiedStoredEntry(throwing, key(), params)).toBeNull();
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
      version: "b1",
      params: { id: "42" },
    });
    expect(isStoredEntryStale(stored, 10999)).toBe(false);
    expect(isStoredEntryStale(stored, 11000)).toBe(true);
  });

  it("never goes stale without a ttl", () => {
    const stored = composeStoredEntry(
      key(),
      entry,
      { tags: [], params: { id: "42" } },
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
        { ttl, tags: [], params: { id: "42" } },
        1000,
      );
      expect(stored.meta.staleAt).toBeUndefined();
      expect(isStoredEntryStale(stored, Number.MAX_SAFE_INTEGER)).toBe(false);
    }
  });
});

describe("isStoredEntryValidFor — malformed durable values read as a miss", () => {
  const k = key();
  const m = { id: "42" };
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
    const meta = { version: k.version, params: m, tags: [], storedAt: 1 };
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

  it("passes when version and params match", () => {
    expect(isStoredEntryValidFor(stored, key(), { id: "42" })).toBe(true);
  });

  it("fails on a param mismatch (DJB2 collision guard)", () => {
    expect(isStoredEntryValidFor(stored, key(), { id: "99" })).toBe(false);
  });

  it("fails on a version mismatch (post-deploy scoping)", () => {
    expect(
      isStoredEntryValidFor(stored, key({ version: "b2" }), { id: "42" }),
    ).toBe(false);
  });

  it("fails on an envelope missing tags or storedAt", () => {
    expect(
      isStoredEntryValidFor(
        { ...stored, meta: { ...stored.meta, tags: undefined } },
        key(),
        { id: "42" },
      ),
    ).toBe(false);
    expect(
      isStoredEntryValidFor(
        { ...stored, meta: { ...stored.meta, storedAt: "1000" } },
        key(),
        { id: "42" },
      ),
    ).toBe(false);
  });
});

// Plain get/set: the store persists the router-composed envelope as given;
// verification belongs to the router (isStoredEntryValidFor above).
function stored(
  over: { ttl?: number; tags?: string[]; params?: Record<string, string> } = {},
  k: PrerenderKey = key(),
  now = 1000,
) {
  return composeStoredEntry(
    k,
    entry,
    {
      ...(over.ttl != null ? { ttl: over.ttl } : {}),
      tags: over.tags ?? [],
      params: over.params ?? { id: "42" },
    },
    now,
  );
}

describe("createMemoryPrerenderStore", () => {
  it("round-trips set -> get and returns the envelope as stored", async () => {
    const store = createMemoryPrerenderStore();
    const envelope = stored({ ttl: 60 });
    await store.set(key(), envelope);
    expect(await store.get(key())).toBe(envelope);
  });

  it("keys by the full key: another version is a different entry", async () => {
    const store = createMemoryPrerenderStore();
    await store.set(
      key({ version: "old" }),
      stored({}, key({ version: "old" })),
    );
    expect(await store.get(key({ version: "new" }))).toBeNull();
    expect(await store.get(key({ version: "old" }))).not.toBeNull();
  });

  it("does NOT memoize misses (a later set is visible)", async () => {
    const store = createMemoryPrerenderStore();
    expect(await store.get(key())).toBeNull();
    await store.set(key(), stored());
    expect(await store.get(key())).not.toBeNull();
  });

  it("markStale marks matching entries stale but keeps serving them", async () => {
    let now = 1000;
    const store = createMemoryPrerenderStore({ now: () => now });
    await store.set(key(), stored({ ttl: 3600, tags: ["product:42"] }));
    now = 2000;
    await store.markStale(["product:42"]);
    const got = await store.get(key());
    // Still served (mark-stale, not delete)...
    expect(got).not.toBeNull();
    // ...but now stale, so the serve path would schedule a refresh.
    expect(isStoredEntryStale(got!, 2000)).toBe(true);
  });

  it("markStale never moves an earlier staleAt later", async () => {
    let now = 5000;
    const store = createMemoryPrerenderStore({ now: () => now });
    await store.set(key(), stored({ ttl: 1, tags: ["t"] }, key(), 1000));
    await store.markStale(["t"]);
    expect((await store.get(key()))?.meta.staleAt).toBe(2000);
  });

  it("markStale leaves non-matching entries fresh", async () => {
    const store = createMemoryPrerenderStore();
    await store.set(
      key(),
      stored({ ttl: 3600, tags: ["other"] }, key(), Date.now()),
    );
    await store.markStale(["product:42"]);
    const got = await store.get(key());
    expect(isStoredEntryStale(got!, Date.now())).toBe(false);
  });

  it("delete removes the entry", async () => {
    const store = createMemoryPrerenderStore();
    await store.set(key(), stored());
    await store.delete(key());
    expect(await store.get(key())).toBeNull();
    expect(store.size).toBe(0);
  });
});

/**
 * isStoredEntryValidFor as it was before the removed marker existed, frozen
 * here. A deploy rolled back to that router reads the markers the newer one
 * wrote when the key version did not move (an app that pins
 * `createRouter({ version })`): it must reject them, so the request is a miss
 * and never an empty page. Do not update this copy with the validator.
 */
function validatorBeforeTheRemovedMarker(
  stored: unknown,
  k: PrerenderKey,
  params: Record<string, string>,
): boolean {
  if (stored == null || typeof stored !== "object") return false;
  const candidate = stored as {
    v?: unknown;
    entry?: { segments?: unknown; handles?: unknown } | null;
    meta?: {
      tags?: unknown;
      storedAt?: unknown;
      version?: unknown;
      params?: Record<string, string>;
    } | null;
  };
  const e = candidate.entry;
  const meta = candidate.meta;
  if (
    candidate.v !== 1 ||
    e == null ||
    typeof e !== "object" ||
    !Array.isArray(e.segments) ||
    typeof e.handles !== "string" ||
    meta == null ||
    typeof meta !== "object" ||
    !Array.isArray(meta.tags) ||
    typeof meta.storedAt !== "number"
  ) {
    return false;
  }
  if (meta.version !== k.version) return false;
  return paramsEqual(meta.params ?? {}, params);
}

describe("the removed marker (tombstone)", () => {
  const params = { id: "42" };
  /** What prerender.remove() stores: no ttl, no tags. */
  const removeMarker = () =>
    composeStoredTombstone(key(), { tags: [], params }, 1000);
  /** What a refresh that hit notFound() stores: the route's ttl and tags. */
  const notFoundMarker = () =>
    composeStoredTombstone(
      key(),
      { ttl: 60, tags: ["product:42"], params },
      1000,
    );

  it("a remove() marker: no entry, no tags, never stale, the key's version and the params", () => {
    const tombstone = removeMarker();
    expect(tombstone).toEqual({
      v: 1,
      removed: true,
      meta: { storedAt: 1000, tags: [], version: "b1", params },
    });
    expect("entry" in tombstone).toBe(false);
    expect(isStoredEntryStale(tombstone, Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(stored()).not.toHaveProperty("removed");
  });

  it("a notFound() marker is stamped like a page: ttl as staleAt, and the tags", () => {
    const tombstone = notFoundMarker();
    expect(tombstone).toEqual({
      v: 1,
      removed: true,
      meta: {
        storedAt: 1000,
        staleAt: 61_000,
        tags: ["product:42"],
        version: "b1",
        params,
      },
    });
    expect("entry" in tombstone).toBe(false);
    expect(tombstone.meta).toEqual(
      stored({ ttl: 60, tags: ["product:42"] }).meta,
    );
    expect(isStoredEntryStale(tombstone, 60_999)).toBe(false);
    expect(isStoredEntryStale(tombstone, 61_000)).toBe(true);
    // An invalid ttl is ignored, as for a page.
    expect(
      composeStoredTombstone(key(), { ttl: NaN, tags: [], params }, 1000).meta,
    ).not.toHaveProperty("staleAt");
  });

  it("is valid under the same version and params checks as a page", () => {
    // The stored JSON, spelled out: what a durable store hands back.
    const tombstone = {
      v: 1,
      removed: true,
      meta: { storedAt: 1000, tags: [], version: "b1", params },
    };
    expect(removeMarker()).toEqual(tombstone);
    expect(isStoredEntryValidFor(notFoundMarker(), key(), params)).toBe(true);
    expect(isStoredEntryValidFor(tombstone, key(), params)).toBe(true);
    // The DJB2 collision guard: another page's marker must not remove this one.
    expect(isStoredEntryValidFor(tombstone, key(), { id: "99" })).toBe(false);
    expect(
      isStoredEntryValidFor(tombstone, key({ version: "b2" }), params),
    ).toBe(false);
    // The JSON round trip a durable store puts it through.
    expect(
      isStoredEntryValidFor(
        JSON.parse(JSON.stringify(tombstone)),
        key(),
        params,
      ),
    ).toBe(true);
  });

  it("a malformed marker reads as a miss, never as a removal", () => {
    const meta = { version: "b1", params, tags: [], storedAt: 1 };
    for (const malformed of [
      { v: 1, removed: true },
      { v: 1, removed: true, meta: null },
      { v: 2, removed: true, meta },
      { v: 1, removed: "true", meta },
      { v: 1, removed: true, meta: { ...meta, storedAt: "1" } },
    ]) {
      expect(isStoredEntryValidFor(malformed as any, key(), params)).toBe(
        false,
      );
    }
  });

  it("a router from before the marker reads either kind as a miss, not as an empty page", () => {
    const page = JSON.parse(JSON.stringify(stored()));
    expect(validatorBeforeTheRemovedMarker(page, key(), params)).toBe(true);
    for (const marker of [removeMarker(), notFoundMarker()]) {
      const tombstone = JSON.parse(JSON.stringify(marker));
      expect(validatorBeforeTheRemovedMarker(tombstone, key(), params)).toBe(
        false,
      );
    }
  });

  it("the memory store persists a remove() marker as given, and markStale leaves it alone", async () => {
    const store = createMemoryPrerenderStore({ now: () => 5000 });
    const tombstone = removeMarker();
    await store.set(key(), tombstone);
    await store.markStale(["product:42"]);

    expect(await store.get(key())).toBe(tombstone);
    expect(tombstone.meta.staleAt).toBeUndefined();
    expect(await readVerifiedStoredEntry(store, key(), params)).toBe(tombstone);
  });

  it("markStale reaches a notFound() marker through its tags, as it reaches a page", async () => {
    const store = createMemoryPrerenderStore({ now: () => 5000 });
    const tombstone = notFoundMarker();
    await store.set(key(), tombstone);
    expect(isStoredEntryStale(tombstone, 5000)).toBe(false);

    await store.markStale(["product:42"]);

    const got = await store.get(key());
    expect(got).toBe(tombstone);
    expect(got).not.toHaveProperty("entry");
    expect(isStoredEntryStale(got!, 5000)).toBe(true);
  });

  it("a later page write replaces it", async () => {
    const store = createMemoryPrerenderStore();
    await store.set(key(), removeMarker());
    const page = stored();
    await store.set(key(), page);
    expect(await store.get(key())).toBe(page);
    expect(store.size).toBe(1);
  });
});
