/**
 * The PPR shell memo's contract, run against both stores that keep one
 * (issue #941, docs/design/shell-entry-layout.md "The shell memo"). Two store
 * instances sharing one backing store stand in for two isolates: for
 * CFCacheStore two copies of its module (the memo is module state, one per
 * isolate) over one Cache API (and KV, when bound); for VercelCacheStore two
 * runtime-cache handles (the memo is per handle) over one backing map.
 * CFCacheStore runs twice: with KV, and KV-less in purge mode, where another
 * isolate learns of an invalidation only through the purge.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SegmentCacheStore, ShellCacheEntry } from "../types.js";
import type { StoreMemoOptions } from "../shell-memo.js";
import {
  VercelCacheStore,
  type VercelRuntimeCache,
} from "../vercel/vercel-cache-store.js";

const T0 = 1_700_000_000_000;
/** A 10 KB prelude: it dominates what either store counts per shell. */
const PRELUDE = "x".repeat(10 * 1024);

function shellEntry(overrides: Partial<ShellCacheEntry> = {}): ShellCacheEntry {
  return {
    prelude: btoa(PRELUDE),
    postponed: null,
    reactVersion: "19.2.6",
    buildVersion: "build-abc",
    createdAt: Date.now(),
    ...overrides,
  };
}

interface Isolates {
  /** The same store configuration in two isolates over one backing store. */
  make(
    memo?: StoreMemoOptions,
  ): Promise<[SegmentCacheStore, SegmentCacheStore]>;
  /** Backing-store reads of a shell entry so far. */
  shellReads(): number;
  /** Let scheduled background writes land. */
  settle(): Promise<void>;
  /**
   * Hold the next invalidateTags() at its slowest write (the tag markers, or
   * the purge in KV-less purge mode) until the returned release is called.
   */
  holdInvalidation(): () => void;
  /** A memo budget with room for one test shell, not two. */
  roomForOneShell: number;
}

/** A gate: `wait()` blocks while held; `hold()` returns the release. */
function gate(): { wait(): Promise<void>; hold(): () => void } {
  let held: Promise<void> | undefined;
  return {
    wait: () => held ?? Promise.resolve(),
    hold() {
      let release!: () => void;
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        held = undefined;
        release();
      };
    },
  };
}

function cfIsolates(options: { kv: boolean }): Isolates {
  const stored = new Map<string, { bytes: Uint8Array; init: ResponseInit }>();
  let reads = 0;
  const cache = {
    async match(request: Request): Promise<Response | undefined> {
      if (request.url.includes("shell2")) reads++;
      const hit = stored.get(request.url);
      return hit ? new Response(hit.bytes.slice(), hit.init) : undefined;
    },
    async put(request: Request, response: Response): Promise<void> {
      stored.set(request.url, {
        bytes: new Uint8Array(await response.arrayBuffer()),
        init: { status: response.status, headers: response.headers },
      });
    },
    async delete(request: Request): Promise<boolean> {
      return stored.delete(request.url);
    },
  };
  const invalidation = gate();
  const kvValues = new Map<string, string>();
  const kv = {
    async get(key: string): Promise<string | null> {
      if (key.includes("shell2")) reads++;
      return kvValues.get(key) ?? null;
    },
    async put(key: string, value: string): Promise<void> {
      if (key.includes("__tag__/")) await invalidation.wait();
      kvValues.set(key, value);
    },
    async delete(key: string): Promise<void> {
      kvValues.delete(key);
    },
  };
  /** Purge-by-tag over the Cache API entries' Cache-Tag headers. */
  const tagPurge = async (tags: string[]): Promise<void> => {
    await invalidation.wait();
    for (const [url, entry] of stored) {
      const header = new Headers(entry.init.headers).get("Cache-Tag") ?? "";
      if (header.split(",").some((token) => tags.includes(token.trim()))) {
        stored.delete(url);
      }
    }
  };
  vi.stubGlobal("caches", { default: cache, open: async () => cache });
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
    passThroughOnException() {},
  };
  return {
    async make(memo) {
      const stores: SegmentCacheStore[] = [];
      for (let i = 0; i < 2; i++) {
        vi.resetModules();
        const { CFCacheStore } = await import("../cf/cf-cache-store.js");
        stores.push(
          new CFCacheStore(
            options.kv ? { ctx, kv: kv as any, memo } : { ctx, tagPurge, memo },
          ),
        );
      }
      return [stores[0]!, stores[1]!];
    },
    shellReads: () => reads,
    async settle() {
      while (pending.length > 0) await Promise.all(pending.splice(0));
    },
    holdInvalidation: () => invalidation.hold(),
    // Counted: the 10 KB prelude plus the snapshot JSON.
    roomForOneShell: 15 * 1024,
  };
}

function vercelIsolates(): Isolates {
  const backing = new Map<
    string,
    { value: unknown; expiresAt: number | null; tags: string[] }
  >();
  let reads = 0;
  const invalidation = gate();
  const handle = (): VercelRuntimeCache => ({
    async get(key) {
      // Shell entries only: a stale read's revalidation lock is `rg:h:k:lock`.
      if (key.startsWith("rg:h:") && !key.endsWith(":lock")) reads++;
      const entry = backing.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt != null && Date.now() >= entry.expiresAt) {
        backing.delete(key);
        return undefined;
      }
      return JSON.parse(JSON.stringify(entry.value));
    },
    async set(key, value, options) {
      if (key.startsWith("rg:tm:")) await invalidation.wait();
      backing.set(key, {
        value: JSON.parse(JSON.stringify(value)),
        expiresAt:
          options?.ttl != null ? Date.now() + options.ttl * 1000 : null,
        tags: options?.tags ?? [],
      });
    },
    async delete(key) {
      backing.delete(key);
    },
    async expireTag(tag) {
      const tags = Array.isArray(tag) ? tag : [tag];
      for (const [key, entry] of backing) {
        if (entry.tags.some((t) => tags.includes(t))) backing.delete(key);
      }
    },
  });
  return {
    async make(memo) {
      return [
        new VercelCacheStore({ cache: handle(), memo }),
        new VercelCacheStore({ cache: handle(), memo }),
      ];
    },
    shellReads: () => reads,
    async settle() {},
    holdInvalidation: () => invalidation.hold(),
    // Counted: the envelope (the prelude as ~13.7 KB of base64) plus the
    // 10 KB decoded prelude.
    roomForOneShell: 30 * 1024,
  };
}

async function read(
  store: SegmentCacheStore,
  key = "k",
): Promise<string | undefined> {
  const hit = await store.getShell!(key);
  return hit ? atob(hit.entry.prelude!).slice(0, 8) : undefined;
}

/**
 * How another isolate's memo learns of an invalidation: "marker", its
 * per-read marker check rejects the shell on the next read; "window", it does
 * not (KV-less purge mode: the purge removes the stored entry only), and the
 * shell serves until the window passes.
 */
type OtherIsolates = "marker" | "window";

describe.each([
  ["CFCacheStore with KV", () => cfIsolates({ kv: true }), "marker"],
  [
    "CFCacheStore KV-less, purge mode",
    () => cfIsolates({ kv: false }),
    "window",
  ],
  ["VercelCacheStore", vercelIsolates, "marker"],
] as const satisfies ReadonlyArray<
  readonly [string, () => Isolates, OtherIsolates]
>)("PPR shell memo contract: %s", (_name, isolates, otherIsolates) => {
  let setup: Isolates;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    setup = isolates();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("serves a repeat read within the window without a backing read", async () => {
    const [a] = await setup.make();
    await a.putShell!("k", shellEntry(), 300, 30);
    await setup.settle();
    await read(a);
    await setup.settle();
    const before = setup.shellReads();
    expect(await read(a)).toBe("xxxxxxxx");
    expect(setup.shellReads()).toBe(before);
  });

  it("reads the backing store again once the window has passed", async () => {
    const [a] = await setup.make({ shellMs: 1000 });
    await a.putShell!("k", shellEntry(), 300, 30);
    await setup.settle();
    await read(a);
    await setup.settle();
    const before = setup.shellReads();
    vi.setSystemTime(new Date(T0 + 1000));
    await read(a);
    expect(setup.shellReads()).toBe(before + 1);
  });

  it("{ shellMs: 0 } reads the backing store every time", async () => {
    const [a] = await setup.make({ shellMs: 0 });
    await a.putShell!("k", shellEntry(), 300, 30);
    await setup.settle();
    const before = setup.shellReads();
    await read(a);
    await setup.settle();
    await read(a);
    expect(setup.shellReads()).toBe(before + 2);
  });

  it("does not keep a stale shell", async () => {
    const [a] = await setup.make({ shellMs: 60_000 });
    await a.putShell!("k", shellEntry(), 1, 300);
    await setup.settle();
    vi.setSystemTime(new Date(T0 + 1500));
    const before = setup.shellReads();
    await read(a);
    await setup.settle();
    await read(a);
    expect(setup.shellReads()).toBe(before + 2);
  });

  it("the invalidating isolate's next read misses", async () => {
    const [a] = await setup.make();
    await a.putShell!("k", shellEntry(), 300, 30, ["home"]);
    await setup.settle();
    expect(await read(a)).toBe("xxxxxxxx");
    await setup.settle();
    vi.setSystemTime(new Date(T0 + 100));
    await a.invalidateTags!(["home"]);
    await setup.settle();
    expect(await read(a)).toBeUndefined();
  });

  // A read on the invalidating isolate while the markers (or the purge) are
  // still being written serves the shell, since nothing has landed yet, but
  // what it memoizes must not outlive the invalidation.
  it("a read during invalidateTags is not served from the memo once it resolves", async () => {
    const [a] = await setup.make();
    await a.putShell!("k", shellEntry(), 300, 30, ["home"]);
    await setup.settle();
    vi.setSystemTime(new Date(T0 + 100));
    const release = setup.holdInvalidation();
    const invalidation = a.invalidateTags!(["home"]);
    expect(await read(a)).toBe("xxxxxxxx");
    await setup.settle();
    release();
    await invalidation;
    await setup.settle();
    vi.setSystemTime(new Date(T0 + 110));
    expect(await read(a)).toBeUndefined();
  });

  it.runIf(otherIsolates === "marker")(
    "an invalidateTags in another isolate rejects the memoized shell on the next read",
    async () => {
      const [a, b] = await setup.make();
      await a.putShell!("k", shellEntry(), 300, 30, ["home"]);
      await setup.settle();
      expect(await read(b)).toBe("xxxxxxxx");
      await setup.settle();
      vi.setSystemTime(new Date(T0 + 100));
      await a.invalidateTags!(["home"]);
      await setup.settle();
      expect(await read(b)).toBeUndefined();
    },
  );

  // KV-less purge mode: the purge removes the stored entry, not another
  // isolate's memo, and that isolate's memo-hit check has no marker to read.
  // This is the mutating user's next request too, when it lands there.
  it.runIf(otherIsolates === "window")(
    "another isolate serves a purged shell until its window passes",
    async () => {
      const [a, b] = await setup.make({ shellMs: 1000 });
      await a.putShell!("k", shellEntry(), 300, 30, ["home"]);
      await setup.settle();
      expect(await read(b)).toBe("xxxxxxxx");
      await setup.settle();
      vi.setSystemTime(new Date(T0 + 100));
      await a.invalidateTags!(["home"]);
      await setup.settle();
      expect(await read(a)).toBeUndefined();
      const before = setup.shellReads();
      expect(await read(b)).toBe("xxxxxxxx");
      expect(setup.shellReads()).toBe(before);
      vi.setSystemTime(new Date(T0 + 1000));
      expect(await read(b)).toBeUndefined();
    },
  );

  it("the isolate's own putShell replaces its memoized copy at once", async () => {
    const [a] = await setup.make();
    await a.putShell!("k", shellEntry({ prelude: btoa("one-one-") }), 300, 30);
    await setup.settle();
    expect(await read(a)).toBe("one-one-");
    await setup.settle();
    await a.putShell!("k", shellEntry({ prelude: btoa("two-two-") }), 300, 30);
    await setup.settle();
    expect(await read(a)).toBe("two-two-");
  });

  it("a newer capture from another isolate is served once the window passes", async () => {
    const [a, b] = await setup.make({ shellMs: 1000 });
    await a.putShell!("k", shellEntry({ prelude: btoa("one-one-") }), 300, 30);
    await setup.settle();
    expect(await read(b)).toBe("one-one-");
    await setup.settle();
    vi.setSystemTime(new Date(T0 + 500));
    await a.putShell!(
      "k",
      shellEntry({ prelude: btoa("two-two-"), createdAt: T0 + 500 }),
      300,
      30,
    );
    await setup.settle();
    expect(await read(b)).toBe("one-one-");
    vi.setSystemTime(new Date(T0 + 1000));
    expect(await read(b)).toBe("two-two-");
  });

  it("evicts the least recently used shell past shellMaxBytes", async () => {
    const [a] = await setup.make({ shellMaxBytes: setup.roomForOneShell });
    await a.putShell!("k", shellEntry(), 300, 30);
    await a.putShell!("other", shellEntry(), 300, 30);
    await setup.settle();
    await read(a, "k");
    await setup.settle();
    await read(a, "other");
    await setup.settle();
    const before = setup.shellReads();
    // "other" (the most recent) is still memoized; "k" was evicted for it.
    expect(await read(a, "other")).toBe("xxxxxxxx");
    expect(setup.shellReads()).toBe(before);
    expect(await read(a, "k")).toBe("xxxxxxxx");
    expect(setup.shellReads()).toBe(before + 1);
  });
});
