/**
 * SegmentCacheStore.scope on the shipped stores: where an entry one request
 * writes can be read. router.prerender() warms a route only when its app
 * store is shared beyond the place the call runs ("global" or "regional");
 * see docs/design/prerender-every-route.md. Design phase: none of the stores
 * declares a scope yet.
 */
import { describe, expect, it } from "vitest";
import { MemorySegmentCacheStore } from "../memory-segment-store.js";
import { CFCacheStore } from "../cf/cf-cache-store.js";
import {
  VercelCacheStore,
  type VercelRuntimeCache,
} from "../vercel/vercel-cache-store.js";

const ctx = {
  waitUntil(_promise: Promise<unknown>): void {},
  passThroughOnException(): void {},
};

/** Never read: the scope is decided at construction. */
const kv = {};

const vercelCache: VercelRuntimeCache = {
  async get() {
    return undefined;
  },
  async set() {},
  async delete() {},
  async expireTag() {},
};

describe("SegmentCacheStore.scope on the shipped stores", () => {
  it("MemorySegmentCacheStore is local: its entries live in one process", () => {
    expect(new MemorySegmentCacheStore()).toHaveProperty("scope", "local");
  });

  it("CFCacheStore with KV is global: an L1 miss in any colo reads KV", () => {
    expect(new CFCacheStore({ ctx: ctx as any, kv: kv as any })).toHaveProperty(
      "scope",
      "global",
    );
  });

  it("CFCacheStore without KV is local: the Cache API is per colo", () => {
    expect(new CFCacheStore({ ctx: ctx as any })).toHaveProperty(
      "scope",
      "local",
    );
  });

  it("CFCacheStore without KV stays local in purge mode", () => {
    expect(
      new CFCacheStore({ ctx: ctx as any, tagPurge: async () => {} }),
    ).toHaveProperty("scope", "local");
  });

  it("VercelCacheStore is regional: each region has its own Runtime Cache", () => {
    expect(new VercelCacheStore({ cache: vercelCache })).toHaveProperty(
      "scope",
      "regional",
    );
  });
});
