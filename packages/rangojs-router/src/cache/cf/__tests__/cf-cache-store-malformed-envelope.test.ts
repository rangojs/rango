import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CFCacheStore } from "../cf-cache-store";

// ============================================================================
// Minimal Cache API + KV mocks (mirrors cf-cache-store-tags.test.ts). The L1
// Cache is cleared after seeding so getResponse() falls through to the KV
// document tier (kvGetResponse), which is the path whose envelope validator we
// are exercising.
// ============================================================================

class MockCache {
  private store = new Map<string, Response>();
  async match(request: Request): Promise<Response | undefined> {
    return this.store.get(request.url)?.clone();
  }
  async put(request: Request, response: Response): Promise<void> {
    this.store.set(request.url, response.clone());
  }
  async delete(request: Request): Promise<boolean> {
    return this.store.delete(request.url);
  }
  clear(): void {
    this.store.clear();
  }
}

class MockCaches {
  private _default = new MockCache();
  async open(): Promise<MockCache> {
    return this._default;
  }
  get default(): MockCache {
    return this._default;
  }
  clear(): void {
    this._default.clear();
  }
}

class MockKV {
  store = new Map<string, string>();
  async get(key: string, options?: { type?: string }): Promise<any> {
    const raw = this.store.get(key);
    if (raw === undefined) return null;
    return options?.type === "json" ? JSON.parse(raw) : raw;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

const mockCaches = new MockCaches();
(globalThis as any).caches = mockCaches;

function createMockCtx() {
  const pending: Promise<any>[] = [];
  return {
    waitUntil: (p: Promise<any>) => {
      pending.push(Promise.resolve(p));
    },
    passThroughOnException: () => {},
    flush: async () => {
      while (pending.length) {
        const batch = pending.splice(0);
        await Promise.all(batch);
      }
    },
  };
}

// Locate the single document envelope KV key written by putResponse (no tags
// are passed, so the KV namespace holds only the doc envelope).
function docKey(kv: MockKV): string {
  const keys = [...kv.store.keys()];
  const found = keys.find((k) => k.includes("doc:"));
  if (!found) throw new Error(`no doc envelope KV key found in: ${keys}`);
  return found;
}

describe("CFCacheStore.kvGetResponse - malformed envelope fails open to a miss", () => {
  let ctx: ReturnType<typeof createMockCtx>;
  let kv: MockKV;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockCaches.clear();
    kv = new MockKV();
    ctx = createMockCtx();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeStore() {
    return new CFCacheStore({
      ctx: ctx as any,
      kv: kv as any,
      baseUrl: "https://test.internal/",
      version: "v1",
    });
  }

  // Seed a valid envelope into KV via putResponse, clear L1 so the read goes to
  // the KV doc tier, then mutate the stored envelope before reading back.
  async function seedAndCorrupt(
    mutate: (envelope: Record<string, unknown>) => void,
  ): Promise<void> {
    const store = makeStore();
    await store.putResponse!(
      "k",
      new Response("body", { status: 200 }),
      300,
      0,
    );
    await ctx.flush();

    const key = docKey(kv);
    const envelope = JSON.parse(kv.store.get(key)!) as Record<string, unknown>;
    mutate(envelope);
    kv.store.set(key, JSON.stringify(envelope));

    // Drop the L1 copy so getResponse must consult the (now malformed) KV entry.
    mockCaches.clear();
  }

  it("treats a non-array hd tuple as a miss, not a throw", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await seedAndCorrupt((e) => {
      // hd must be [name, value][]; a bare string element would throw in
      // `new Headers(hd)` if it ever reached the constructor.
      (e as any).hd = ["not-a-tuple"];
    });

    const store = makeStore();
    await expect(store.getResponse!("k")).resolves.toBeNull();
    errSpy.mockRestore();
  });

  it("treats a wrong-arity hd tuple as a miss, not a throw", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await seedAndCorrupt((e) => {
      (e as any).hd = [["only-one-element"]];
    });

    const store = makeStore();
    await expect(store.getResponse!("k")).resolves.toBeNull();
    errSpy.mockRestore();
  });

  it("treats a non-string hd value as a miss, not a throw", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await seedAndCorrupt((e) => {
      (e as any).hd = [["x-foo", 123]];
    });

    const store = makeStore();
    await expect(store.getResponse!("k")).resolves.toBeNull();
    errSpy.mockRestore();
  });

  it("treats a non-string statusText (stx) as a miss, not a throw", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await seedAndCorrupt((e) => {
      (e as any).stx = 42;
    });

    const store = makeStore();
    await expect(store.getResponse!("k")).resolves.toBeNull();
    errSpy.mockRestore();
  });

  it("still serves a well-formed envelope (control)", async () => {
    const store = makeStore();
    await store.putResponse!(
      "k",
      new Response("body", { status: 200 }),
      300,
      0,
    );
    await ctx.flush();
    mockCaches.clear();

    const hit = await store.getResponse!("k");
    expect(hit).not.toBeNull();
    expect(hit!.response.status).toBe(200);
    expect(await hit!.response.text()).toBe("body");
  });
});
