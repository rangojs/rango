/**
 * CFCacheStore read hot path: an L1 hit, a miss on both tiers, and an L1
 * miss that falls through to a KV hit (promoted in the background). Uses
 * only the store's public API, so it runs unchanged on any revision.
 *
 * Run: ./node_modules/.bin/vitest bench --run src/cache/cf/__tests__/cf-cache-store-read.bench.ts
 */
import { bench, describe, vi } from "vitest";
import { CFCacheStore, type KVNamespace } from "../cf-cache-store.js";
import type { CachedEntryData } from "../../types.js";

/** The Cache API; `keep: false` drops writes, so every read stays an L1 miss. */
class BenchCache {
  readonly entries = new Map<string, Response>();
  keep = true;
  async match(request: Request): Promise<Response | undefined> {
    return this.entries.get(request.url)?.clone();
  }
  async put(request: Request, response: Response): Promise<void> {
    const stored = new Response(await response.arrayBuffer(), response);
    if (this.keep) this.entries.set(request.url, stored);
  }
  async delete(request: Request): Promise<boolean> {
    return this.entries.delete(request.url);
  }
}

class BenchKV implements KVNamespace {
  readonly values = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

const l1 = new BenchCache();
vi.stubGlobal("caches", {
  default: l1,
  open: async () => l1,
});
const kv = new BenchKV();
const pending: Promise<unknown>[] = [];
const store = new CFCacheStore({
  ctx: {
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
    },
    passThroughOnException: () => {},
  },
  kv,
});

const data: CachedEntryData = {
  segments: [],
  handles: "h".repeat(2048),
  expiresAt: 0,
};
await store.set("hit", data, 600, 600);
await store.set("kv-only", data, 600, 600);
await Promise.all(pending.splice(0));
for (const url of [...l1.entries.keys()]) {
  if (url.endsWith("/kv-only")) l1.entries.delete(url);
}

describe("CFCacheStore.get", () => {
  bench("L1 hit", async () => {
    await store.get("hit");
  });

  bench("miss (L1 and KV)", async () => {
    await store.get("absent");
  });

  bench(
    "L1 miss, KV hit (promoted)",
    async () => {
      await store.get("kv-only");
      await Promise.all(pending.splice(0));
    },
    {
      setup: () => {
        l1.keep = false;
      },
      teardown: () => {
        l1.keep = true;
      },
    },
  );
});
