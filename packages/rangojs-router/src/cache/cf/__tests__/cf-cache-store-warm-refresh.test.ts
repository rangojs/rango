/**
 * The global-refresh sequence documented for a `router.prerender()` warm on
 * CFCacheStore with KV (docs/design/prerender-every-route.md, "What the stores
 * cannot do in place: other edge locations"), seen from more than one edge
 * location: `updateTag(tag)`, then the warm's write.
 *
 * What this shows: the store's read flow across CFCacheStore instances that
 * share ONE KV and each have their OWN Cache API (L1).
 * - A valid L1 hit never reads the entry's KV key, so a colo keeps serving
 *   its own copy until that copy expires, whatever another colo wrote to KV
 *   since. A warm that replaces an entry is therefore not a cross-colo
 *   refresh.
 * - A tag marker in KV makes an older L1 copy unservable in every colo.
 * - A read that misses L1 finds the KV entry and promotes it. So after
 *   updateTag and the warm's write, a colo with no copy of its own (or whose
 *   copy a tagPurge evicted) reads the warmed entry.
 * - A colo that still holds its invalidated copy reads the entry's KV key as
 *   a colo with no copy does (cf-cache-store.ts get(), "Tag invalidation"):
 *   the warmed entry when it was written after the marker, and promoted over
 *   the old copy; a miss when KV still answers with the entry from before the
 *   marker. It never serves the old copy. The request that invalidated the
 *   tag itself keeps the miss without the KV read (ownMaskRejects).
 *
 * What it cannot show, because it is platform behavior and not store code:
 * - Cloudflare KV's propagation delay (a write "may take up to 60 seconds or
 *   more to be visible in other global network locations"). The KV here is
 *   one Map: a put is visible to every colo at once, the marker included.
 *   One case stands in for the delay by putting the value from before the
 *   marker back under the entry's key.
 * - The Cache API's real per-colo isolation and eviction, and a real
 *   purge-by-tag. A colo here is a Map the `caches` stub switches to for the
 *   length of one request; the purge is a loop over those Maps.
 * - The isolate memo windows (cfShellMemo and cfMarkerMemo in
 *   cf-cache-store.ts). They are module-level, so the stores of one test
 *   process share one "isolate" and one colo's memo would answer another
 *   colo's read. Every store here turns them off
 *   (`memo: { shellMs: 0, markerFreshMs: 0 }`) and beforeEach resets them, so
 *   each read below is an L1 or a KV read. The two shell-memo cases turn the
 *   shell memo on; the one that needs two isolates evaluates the store module
 *   twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CFCacheStore,
  KV_READ_TIMEOUT_MS,
  TAG_MARKER_PREFIX,
  resetCFShellMemoForTests,
} from "../cf-cache-store.js";
import {
  CACHE_READ_ERROR,
  type CacheGetResult,
  type CacheReadError,
  type CachedEntryData,
  type ShellCacheEntry,
} from "../../types.js";
import {
  _getRequestContext,
  createRequestContext,
  runWithRequestContext,
} from "../../../server/request-context.js";
import { maskRequestTags } from "../../request-tag-mask.js";
import {
  executionStart,
  predatesInvalidation,
  updateTag,
} from "../../tag-invalidation.js";

const TAG = "products";
const KEY = "doc:shop.example/products";
const SHELL_KEY = "shop.example/products:shell";

/**
 * One colo's Cache API. Honors `max-age` against the fake clock (like
 * cf-cache-store-tags.test.ts MockCache): the real one may evict earlier but
 * never serves past it, which is the bound a colo's own copy lives under.
 */
class ColoCache {
  private readonly entries = new Map<
    string,
    { response: Response; expiresAt: number }
  >();
  /** Lookups so far: a read answered from an isolate memo adds none. */
  matches = 0;

  async match(request: Request): Promise<Response | undefined> {
    this.matches += 1;
    const entry = this.entries.get(request.url);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(request.url);
      return undefined;
    }
    return entry.response.clone();
  }

  async put(request: Request, response: Response): Promise<void> {
    const maxAge = /max-age=(\d+)/.exec(
      response.headers.get("Cache-Control") ?? "",
    );
    this.entries.set(request.url, {
      response: response.clone(),
      expiresAt:
        Date.now() +
        (maxAge ? Number(maxAge[1]) : Number.POSITIVE_INFINITY) * 1000,
    });
  }

  async delete(request: Request): Promise<boolean> {
    return this.entries.delete(request.url);
  }

  /** Purge-by-tag: drop every entry whose Cache-Tag names one of `tokens`. */
  purge(tokens: string[]): void {
    for (const [url, { response }] of this.entries) {
      const held = (response.headers.get("Cache-Tag") ?? "")
        .split(",")
        .map((token) => token.trim());
      if (held.some((token) => tokens.includes(token))) {
        this.entries.delete(url);
      }
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * The KV namespace every colo is bound to. Honors `expirationTtl`, and
 * records the keys read so a test can tell an entry read from a marker read.
 */
class SharedKV {
  private readonly values = new Map<
    string,
    { value: string; expiresAt: number }
  >();
  private readonly reads: string[] = [];
  /** Entry reads (not marker reads) take this long, when set. */
  entryReadDelayMs = 0;
  /** Entry reads (not marker reads) reject, when set. */
  entryReadsFail = false;

  async get(key: string, options?: { type?: string }): Promise<unknown> {
    this.reads.push(key);
    if (!key.includes(TAG_MARKER_PREFIX)) {
      if (this.entryReadsFail) throw new Error("KV unavailable");
      if (this.entryReadDelayMs > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.entryReadDelayMs),
        );
      }
    }
    const held = this.values.get(key);
    if (!held) return null;
    if (Date.now() > held.expiresAt) {
      this.values.delete(key);
      return null;
    }
    return options?.type === "json" ? JSON.parse(held.value) : held.value;
  }

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void> {
    this.values.set(key, {
      value,
      expiresAt:
        options?.expirationTtl !== undefined
          ? Date.now() + options.expirationTtl * 1000
          : Number.POSITIVE_INFINITY,
    });
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  /** Stored keys that hold an entry (not a tag marker). */
  entryKeys(): string[] {
    return [...this.values.keys()].filter(
      (key) => !key.includes(TAG_MARKER_PREFIX),
    );
  }

  /** Keys read since the last call, entries apart from tag markers. */
  takeReads(): { entries: string[]; markers: string[] } {
    const keys = this.reads.splice(0);
    return {
      entries: keys.filter((key) => !key.includes(TAG_MARKER_PREFIX)),
      markers: keys.filter((key) => key.includes(TAG_MARKER_PREFIX)),
    };
  }

  /** Entry keys read since the last call (tag-marker reads left out). */
  takeEntryReads(): string[] {
    return this.takeReads().entries;
  }

  /** The stored value of an entry key, without counting a read. */
  peek(key: string): string | undefined {
    return this.values.get(key)?.value;
  }
}

interface Colo {
  l1: ColoCache;
  store: CFCacheStore;
  /** Await the store's waitUntil work, nested tasks included. */
  flush(): Promise<void>;
}

let kv: SharedKV;
let colos: Colo[];
/** The colo whose Cache API `caches` resolves to: the one serving a request. */
let serving: Colo | undefined;

function createColo(
  options: {
    tagPurge?: (cacheTags: string[]) => Promise<void>;
    memo?: { shellMs?: number; markerFreshMs?: number };
    debug?: (event: { outcome: string }) => void;
    /** CFCacheStore from another evaluation of its module: another isolate. */
    Store?: typeof CFCacheStore;
  } = {},
): Colo {
  const { Store = CFCacheStore, ...storeOptions } = options;
  const pending: Promise<unknown>[] = [];
  const colo: Colo = {
    l1: new ColoCache(),
    store: new Store({
      ctx: {
        waitUntil: (task: Promise<unknown>) => {
          pending.push(Promise.resolve(task));
        },
        passThroughOnException() {},
      } as any,
      kv: kv as any,
      baseUrl: "https://shop.example/",
      version: "v1",
      memo: { shellMs: 0, markerFreshMs: 0 },
      ...storeOptions,
    }),
    async flush() {
      while (pending.length > 0) await Promise.all(pending.splice(0));
    },
  };
  colos.push(colo);
  return colo;
}

/** Cloudflare's zone purge-by-tag: it reaches the Cache API of every colo. */
async function purgeEveryColo(cacheTags: string[]): Promise<void> {
  for (const colo of colos) colo.l1.purge(cacheTags);
}

/**
 * One request served by `colo`, in its own request context (its own
 * per-request marker memo and tag mask). `caches` resolves to this colo's
 * Cache API until the request's background work (the L1 and KV writes, a KV
 * hit's promotion into L1) has landed, so the next request, in whichever
 * colo, reads what this one wrote.
 */
async function request<T>(
  colo: Colo,
  serve: (store: CFCacheStore) => Promise<T>,
): Promise<T> {
  serving = colo;
  const reqCtx = createRequestContext({
    env: {},
    request: new Request("https://shop.example/products"),
    url: new URL("https://shop.example/products"),
    variables: {},
    cacheStore: colo.store,
  });
  const result = await runWithRequestContext(reqCtx, () => serve(colo.store));
  await Promise.all(reqCtx._pendingBackgroundTasks ?? []);
  await colo.flush();
  return result;
}

/** A later moment: the store compares its timestamps in whole milliseconds. */
function later(ms = 1_000): void {
  vi.advanceTimersByTime(ms);
}

/** A tagged segment entry that renders `content`. */
function segmentEntry(content: string): CachedEntryData {
  return {
    segments: [
      {
        encoded: content,
        metadata: {
          id: "seg",
          type: "route",
          namespace: "test",
          index: 0,
          params: {},
        },
      },
    ],
    handles: "",
    expiresAt: Date.now() + 300_000,
    tags: [TAG],
  };
}

/** The content a segment read served, or null on a miss. */
function servedSegment(
  read: CacheGetResult | null | CacheReadError,
): string | null {
  if (read === null || read === CACHE_READ_ERROR) return null;
  return read.data.segments[0]?.encoded ?? null;
}

const readSegment = (colo: Colo): Promise<string | null> =>
  request(colo, async (store) => servedSegment(await store.get(KEY)));

/** A document shell whose prelude is `html`, captured now. */
function shellEntry(html: string): ShellCacheEntry {
  return {
    prelude: btoa(html),
    postponed: JSON.stringify({ hole: 1 }),
    reactVersion: "19.2.6",
    buildVersion: "build-abc",
    createdAt: Date.now(),
    snapshot: [],
  };
}

/** The prelude a shell read served, or null on a miss. */
const readShell = (colo: Colo): Promise<string | null> =>
  request(colo, async (store) => {
    const read = await store.getShell(SHELL_KEY);
    return read?.entry.prelude !== undefined ? atob(read.entry.prelude) : null;
  });

beforeEach(() => {
  vi.restoreAllMocks();
  resetCFShellMemoForTests();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  kv = new SharedKV();
  colos = [];
  serving = undefined;
  vi.stubGlobal("caches", {
    get default(): ColoCache {
      return serving!.l1;
    },
    open: async (): Promise<ColoCache> => serving!.l1,
  });
  // invalidateTags warns once per isolate that the markers have no expiry.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("CFCacheStore with KV: a warm's segment write, seen from another colo", () => {
  /** Colo A wrote v1 and colo B read it, so B holds its own L1 copy. */
  async function bothColosHoldV1(
    options?: Parameters<typeof createColo>[0],
  ): Promise<{ a: Colo; b: Colo }> {
    const a = createColo(options);
    const b = createColo(options);
    await request(a, (store) => store.set(KEY, segmentEntry("v1"), 300));
    later();
    kv.takeEntryReads();
    expect(await readSegment(b)).toBe("v1");
    // B had no copy: it read the entry from KV and promoted it.
    expect(kv.takeEntryReads()).toHaveLength(1);
    expect(b.l1.size).toBe(1);
    later();
    return { a, b };
  }

  /**
   * `updateTag(TAG)` in colo A, then the warm's replace there: an execution
   * that starts after the invalidation, so the cache layers' write gate
   * (tag-invalidation.ts predatesInvalidation) lets it write.
   */
  async function updateTagThenWarm(a: Colo): Promise<void> {
    await request(a, () => updateTag(TAG));
    later();
    await request(a, async (store) => {
      const start = executionStart();
      expect(await predatesInvalidation(store, [TAG], start)).toBe(false);
      await store.set(KEY, segmentEntry("v2"), 300);
    });
    later();
  }

  it("without an invalidation another colo keeps serving its own L1 copy", async () => {
    const { a, b } = await bothColosHoldV1();

    // The warm's replace, in the colo the call ran in.
    await request(a, (store) => store.set(KEY, segmentEntry("v2"), 300));
    later();
    kv.takeEntryReads();

    expect(await readSegment(b)).toBe("v1");
    // An L1 hit: the entry's KV key, which holds v2, was not read.
    expect(kv.takeEntryReads()).toEqual([]);
    expect(await readSegment(a)).toBe("v2");
  });

  it("the other colo's own copy serves until it expires; its next read is the warmed entry from KV", async () => {
    const { a, b } = await bothColosHoldV1();
    await request(a, (store) => store.set(KEY, segmentEntry("v2"), 300));

    // B promoted v1 with the entry's remaining lifetime as max-age: its copy
    // ends with v1's 300 s, two seconds before v2's.
    later(297_000);
    expect(await readSegment(b)).toBe("v1");
    later(2_000);
    kv.takeEntryReads();
    expect(await readSegment(b)).toBe("v2");
    expect(kv.takeEntryReads()).toHaveLength(1);
  });

  it("updateTag then the warm's write: a colo with no L1 copy reads the warmed entry from KV", async () => {
    const { a } = await bothColosHoldV1();
    await updateTagThenWarm(a);

    const cold = createColo();
    kv.takeEntryReads();
    expect(await readSegment(cold)).toBe("v2");
    expect(kv.takeEntryReads()).toHaveLength(1);
    // Promoted: the colo's next read is its own L1 copy of v2.
    expect(await readSegment(cold)).toBe("v2");
    expect(kv.takeEntryReads()).toEqual([]);
  });

  it("updateTag then the warm's write, with tagPurge: the purge evicts the other colo's copy and its next read is the warmed entry", async () => {
    const { a, b } = await bothColosHoldV1({ tagPurge: purgeEveryColo });
    await updateTagThenWarm(a);

    expect(b.l1.size).toBe(0);
    kv.takeEntryReads();
    expect(await readSegment(b)).toBe("v2");
    expect(kv.takeEntryReads()).toHaveLength(1);
  });

  it("debug: the rejected copy's tag-invalidated event is followed by the KV read's own event", async () => {
    const outcomes: string[] = [];
    const { a, b } = await bothColosHoldV1({
      debug: (event) => outcomes.push(event.outcome),
    });
    await request(a, () => updateTag(TAG));
    later();

    // KV still holds the twin written with the rejected copy.
    outcomes.length = 0;
    expect(await readSegment(b)).toBeNull();
    expect(outcomes).toEqual(["tag-invalidated", "tag-invalidated"]);

    await request(a, (store) => store.set(KEY, segmentEntry("v2"), 300));
    later();
    outcomes.length = 0;
    expect(await readSegment(b)).toBe("v2");
    expect(outcomes).toEqual(["tag-invalidated", "kv-fresh"]);
  });

  it("a KV read that fails after a rejected copy answers CACHE_READ_ERROR, as it does after an L1 miss", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { a, b } = await bothColosHoldV1();
    await updateTagThenWarm(a);
    const cold = createColo();
    kv.entryReadsFail = true;

    const get = (colo: Colo) => request(colo, (store) => store.get(KEY));

    // Not a miss: KV may hold the entry the read could not reach.
    expect(await get(b)).toBe(CACHE_READ_ERROR);
    expect(await get(cold)).toBe(CACHE_READ_ERROR);
  });

  it("an entry whose ttl + swr is under 60 s never reaches KV", async () => {
    const a = createColo();
    const b = createColo();

    await request(a, (store) => store.set(KEY, segmentEntry("short"), 30, 29));

    expect(kv.entryKeys()).toEqual([]);
    expect(await readSegment(a)).toBe("short");
    expect(await readSegment(b)).toBeNull();
  });

  it("an entry whose ttl + swr is 60 s reaches KV and is readable in the other colo", async () => {
    const a = createColo();
    const b = createColo();

    await request(a, (store) => store.set(KEY, segmentEntry("minute"), 30, 30));

    expect(kv.entryKeys()).toHaveLength(1);
    expect(await readSegment(b)).toBe("minute");
  });
});

/** One data family: how a warm writes `content` under KEY, and a read of it. */
interface Family {
  name: string;
  write(
    store: CFCacheStore,
    content: string,
    ttl?: number,
    swr?: number,
  ): Promise<void>;
  /** The content served and its SWR flag, or null on a miss. */
  read(
    store: CFCacheStore,
  ): Promise<{ content: string; shouldRevalidate: boolean } | null>;
}

const families: Family[] = [
  {
    name: "segment (get)",
    write: (store, content, ttl = 300, swr) =>
      store.set(KEY, segmentEntry(content), ttl, swr),
    read: async (store) => {
      const hit = await store.get(KEY);
      const content = servedSegment(hit);
      if (hit === null || hit === CACHE_READ_ERROR || content === null) {
        return null;
      }
      return { content, shouldRevalidate: hit.shouldRevalidate };
    },
  },
  {
    name: '"use cache" item (getItem)',
    write: (store, content, ttl = 300, swr) =>
      store.setItem(KEY, content, { ttl, swr, tags: [TAG] }),
    read: async (store) => {
      const hit = await store.getItem(KEY);
      return hit
        ? { content: hit.value, shouldRevalidate: hit.shouldRevalidate }
        : null;
    },
  },
  {
    name: "response (getResponse)",
    write: (store, content, ttl = 300, swr) =>
      store.putResponse(KEY, new Response(content), ttl, swr, [TAG]),
    read: async (store) => {
      const hit = await store.getResponse(KEY);
      return hit
        ? {
            content: await hit.response.text(),
            shouldRevalidate: hit.shouldRevalidate,
          }
        : null;
    },
  },
];

describe.each(families)(
  "CFCacheStore with KV: an L1 copy a tag marker rejects reads the entry's KV key, $name",
  (family) => {
    const read = async (colo: Colo): Promise<string | null> =>
      (await request(colo, family.read))?.content ?? null;

    /** Colo A wrote v1 and colo B read it, so B holds its own L1 copy. */
    async function bothColosHoldV1(
      options?: Parameters<typeof createColo>[0],
      ttl?: number,
      swr?: number,
    ): Promise<{ a: Colo; b: Colo }> {
      const a = createColo(options);
      const b = createColo(options);
      await request(a, (store) => family.write(store, "v1", ttl, swr));
      later();
      expect(await read(b)).toBe("v1");
      expect(b.l1.size).toBe(1);
      later();
      kv.takeReads();
      return { a, b };
    }

    /** `updateTag(TAG)` in colo A, then the warm's replace there. */
    async function updateTagThenWarm(
      a: Colo,
      ttl?: number,
      swr?: number,
    ): Promise<void> {
      await request(a, () => updateTag(TAG));
      later();
      await request(a, async (store) => {
        const start = executionStart();
        expect(await predatesInvalidation(store, [TAG], start)).toBe(false);
        await family.write(store, "v2", ttl, swr);
      });
      later();
      kv.takeReads();
    }

    it("updateTag then the warm's write: the colo holding the old copy serves the warmed entry from KV, then from its own L1", async () => {
      const { a, b } = await bothColosHoldV1();
      await updateTagThenWarm(a);

      expect(await read(b)).toBe("v2");
      // One marker read rejected the L1 copy; the KV entry was checked
      // against that same value (the per-request memo), not a second read.
      expect(kv.takeReads()).toMatchObject({
        entries: { length: 1 },
        markers: { length: 1 },
      });
      // Promoted over the old copy: B's next read is its own L1.
      expect(await read(b)).toBe("v2");
      expect(kv.takeReads().entries).toEqual([]);
      expect(await read(a)).toBe("v2");
    });

    it("updateTag with no warm: KV holds the entry from before the marker, which is refused", async () => {
      const { a, b } = await bothColosHoldV1();
      await request(a, () => updateTag(TAG));
      later();
      kv.takeReads();

      expect(await read(b)).toBeNull();
      // The cost of the fall-through: the entry's KV key, read once.
      expect(kv.takeReads().entries).toHaveLength(1);
      // Nothing was promoted, and the next read is refused the same way.
      expect(await read(b)).toBeNull();
    });

    it("updateTag then the warm's write, KV still answering with the entry from before the marker: refused, not served", async () => {
      const { a, b } = await bothColosHoldV1();
      const [entryKey] = kv.entryKeys();
      const beforeMarker = kv.peek(entryKey!)!;
      await updateTagThenWarm(a);
      // KV is eventually consistent: this location's read can return the
      // value from before the warm (and before the marker) for a while.
      await kv.put(entryKey!, beforeMarker, { expirationTtl: 300 });

      expect(await read(b)).toBeNull();
      expect(kv.takeReads().entries).toHaveLength(1);
    });

    it("an L1 copy no marker rejects is served with one marker read and no entry read", async () => {
      const { b } = await bothColosHoldV1();

      expect(await read(b)).toBe("v1");
      expect(kv.takeReads()).toEqual({
        entries: [],
        markers: [expect.stringContaining(TAG)],
      });
    });

    it("the request that ran updateTag misses its own copy without reading the entry's KV key", async () => {
      const { b } = await bothColosHoldV1();

      const served = await request(b, async (store) => {
        await updateTag(TAG);
        return family.read(store);
      });

      expect(served).toBeNull();
      expect(kv.takeReads().entries).toEqual([]);
    });

    it("a KV read slower than kvReadTimeoutMs on the fall-through is a miss when the budget ends", async () => {
      const { a, b } = await bothColosHoldV1();
      await updateTagThenWarm(a);
      kv.entryReadDelayMs = 10_000;

      let settled = false;
      const pending = read(b).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(KV_READ_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(await pending).toBeNull();
    });

    it("a KV read that fails on the fall-through is not a hit, and the old copy is still not served", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const { a, b } = await bothColosHoldV1();
      await updateTagThenWarm(a);
      kv.entryReadsFail = true;

      expect(await read(b)).toBeNull();
      expect(error).toHaveBeenCalled();
    });

    it("SWR for an L1 copy no marker rejects: the stale copy serves, the first reader revalidates, and KV is not read", async () => {
      const { b } = await bothColosHoldV1(undefined, 60, 300);
      later(60_000);
      kv.takeReads();

      const reads = [
        await request(b, family.read),
        await request(b, family.read),
      ];

      expect(reads).toEqual([
        { content: "v1", shouldRevalidate: true },
        // The first reader marked the copy REVALIDATING.
        { content: "v1", shouldRevalidate: false },
      ]);
      expect(kv.takeReads().entries).toEqual([]);
    });

    it("SWR on the fall-through: a stale warmed entry serves as it does to a colo with no copy", async () => {
      const { a, b } = await bothColosHoldV1(undefined, 600);
      await updateTagThenWarm(a, 60, 300);
      const cold = createColo();
      later(60_000);

      const sequence = async (colo: Colo) => [
        await request(colo, family.read),
        await request(colo, family.read),
        await request(colo, family.read),
      ];

      const held = await sequence(b);
      expect(held).toEqual(await sequence(cold));
      expect(held).toEqual([
        // KV has no REVALIDATING guard: the KV read and the first reader of
        // the promoted L1 copy each revalidate; then the guard holds.
        { content: "v2", shouldRevalidate: true },
        { content: "v2", shouldRevalidate: true },
        { content: "v2", shouldRevalidate: false },
      ]);
    });

    it("tagPurge, the purge not at this colo yet: a copy the request's marker memo rejects reads the warmed entry", async () => {
      // A purge that has not reached colo B: its copy survives, and an L1
      // hit in purge mode reads no marker of its own.
      const { a, b } = await bothColosHoldV1({ tagPurge: async () => {} });
      await updateTagThenWarm(a);
      // A second entry under the same tag that B holds no copy of.
      await request(a, (store) =>
        store.setItem("other", "o1", { ttl: 300, tags: [TAG] }),
      );
      kv.takeReads();

      const served = await request(b, async (store) => {
        // A KV-tier read: it reads the tag's marker into the request's memo.
        expect((await store.getItem("other"))?.value).toBe("o1");
        return family.read(store);
      });

      expect(served?.content).toBe("v2");
    });
  },
);

describe("CFCacheStore with KV: a warm's shell write, seen from another colo", () => {
  const putShell = (
    colo: Colo,
    entry: ShellCacheEntry,
    ttl = 300,
    swr = 0,
  ): Promise<"stored" | "invalidated" | "uncacheable" | void> =>
    request(colo, (store) => store.putShell(SHELL_KEY, entry, ttl, swr, [TAG]));

  /** Colo A captured v1 and colo B read it, so B holds its own L1 copy. */
  async function bothColosHoldV1(): Promise<{ a: Colo; b: Colo }> {
    const a = createColo();
    const b = createColo();
    expect(await putShell(a, shellEntry("v1"))).toBe("stored");
    later();
    kv.takeEntryReads();
    expect(await readShell(b)).toBe("v1");
    expect(kv.takeEntryReads()).toHaveLength(1);
    expect(b.l1.size).toBe(1);
    later();
    return { a, b };
  }

  /**
   * `updateTag(TAG)` in colo A, then the warm's capture there: it started
   * after the invalidation, so putShell's generation gate stores it.
   */
  async function updateTagThenWarm(a: Colo): Promise<void> {
    await request(a, () => updateTag(TAG));
    later();
    expect(await putShell(a, shellEntry("v2"))).toBe("stored");
    later();
  }

  it("without an invalidation another colo keeps serving its own L1 copy", async () => {
    const { a, b } = await bothColosHoldV1();

    expect(await putShell(a, shellEntry("v2"))).toBe("stored");
    later();
    kv.takeEntryReads();

    expect(await readShell(b)).toBe("v1");
    expect(kv.takeEntryReads()).toEqual([]);
    expect(await readShell(a)).toBe("v2");
  });

  it("updateTag then the warm's write: a colo with no L1 copy reads the warmed shell from KV", async () => {
    const { a } = await bothColosHoldV1();
    await updateTagThenWarm(a);

    const cold = createColo();
    kv.takeEntryReads();
    expect(await readShell(cold)).toBe("v2");
    expect(kv.takeEntryReads()).toHaveLength(1);
    expect(await readShell(cold)).toBe("v2");
    expect(kv.takeEntryReads()).toEqual([]);
  });

  it("updateTag then the warm's write: the colo holding the old L1 copy serves the warmed shell from KV, then from its own L1", async () => {
    const { a, b } = await bothColosHoldV1();
    await updateTagThenWarm(a);
    kv.takeReads();

    expect(await readShell(b)).toBe("v2");
    // The KV frame was checked against the marker value that rejected the L1
    // frame (the request's shell marker reads), not a second read.
    expect(kv.takeReads()).toMatchObject({
      entries: { length: 1 },
      markers: { length: 1 },
    });
    expect(await readShell(b)).toBe("v2");
    expect(kv.takeReads().entries).toEqual([]);
    expect(await readShell(a)).toBe("v2");
  });

  it("updateTag with no warm: KV holds the shell from before the marker, which is refused", async () => {
    const { a, b } = await bothColosHoldV1();
    await request(a, () => updateTag(TAG));
    later();
    kv.takeReads();

    expect(await readShell(b)).toBeNull();
    expect(kv.takeReads().entries).toHaveLength(1);
    expect(await readShell(b)).toBeNull();
  });

  it("the request that ran updateTag misses its own shell without reading its KV key", async () => {
    const { b } = await bothColosHoldV1();
    kv.takeReads();

    const served = await request(b, async (store) => {
      await updateTag(TAG);
      return store.getShell(SHELL_KEY);
    });

    expect(served).toBeNull();
    expect(kv.takeReads().entries).toEqual([]);
  });

  it("a memoized shell the request's own mask rejects stays a miss with no store read", async () => {
    const colo = createColo({ memo: { shellMs: 2_000, markerFreshMs: 0 } });
    expect(await putShell(colo, shellEntry("v1"))).toBe("stored");
    later(100);
    expect(await readShell(colo)).toBe("v1");
    const storeReads = colo.l1.matches;
    kv.takeReads();

    const served = await request(colo, async (store) => {
      // The mask alone: invalidateTags() also drops the isolate's memoized
      // shells for the tag, which would keep this read off the memo.
      maskRequestTags(_getRequestContext()!, store, [TAG], Date.now());
      return store.getShell(SHELL_KEY);
    });

    expect(served).toBeNull();
    expect(colo.l1.matches).toBe(storeReads);
    expect(kv.takeReads().entries).toEqual([]);
  });

  it("a shell the isolate memoized: once a marker rejects it, the read goes to the store and serves the warmed shell", async () => {
    // Two evaluations of the store module: two isolates, each with its own
    // shell memo. They run without a request context (its AsyncLocalStorage
    // belongs to the module graph this file imported).
    vi.resetModules();
    const warming = createColo({
      Store: (await import("../cf-cache-store.js")).CFCacheStore,
    });
    vi.resetModules();
    const holding = createColo({
      Store: (await import("../cf-cache-store.js")).CFCacheStore,
      memo: { shellMs: 2_000, markerFreshMs: 0 },
    });
    const on = async <T>(
      colo: Colo,
      run: (store: CFCacheStore) => Promise<T>,
    ): Promise<T> => {
      serving = colo;
      const result = await run(colo.store);
      await colo.flush();
      return result;
    };
    const prelude = (colo: Colo): Promise<string | undefined> =>
      on(colo, async (store) => {
        const read = await store.getShell(SHELL_KEY);
        return read?.entry.prelude && atob(read.entry.prelude);
      });
    const write = (html: string): Promise<unknown> =>
      on(warming, (store) =>
        store.putShell(SHELL_KEY, shellEntry(html), 300, 0, [TAG]),
      );

    expect(await write("v1")).toBe("stored");
    later(100);
    expect(await prelude(holding)).toBe("v1");
    const storeReads = holding.l1.matches;
    expect(await prelude(holding)).toBe("v1");
    // Memoized: the second read reached neither the Cache API nor KV.
    expect(holding.l1.matches).toBe(storeReads);

    later(100);
    await on(warming, (store) => store.invalidateTags([TAG]));
    later(100);
    expect(await write("v2")).toBe("stored");
    later(100);

    // Inside the memo window: the memoized v1 is rejected, and the store
    // read behind it finds the L1 copy rejected too and v2 in KV.
    expect(await prelude(holding)).toBe("v2");
    vi.resetModules();
  });

  it("a capture that started before the invalidation is refused in every colo, so it cannot replace the warm's shell", async () => {
    const { a, b } = await bothColosHoldV1();
    // A visitor's capture in colo B starts, then colo A invalidates and warms.
    const visitorCapture = shellEntry("stale");
    later();
    await updateTagThenWarm(a);

    expect(await putShell(b, visitorCapture)).toBe("invalidated");
    expect(await readShell(a)).toBe("v2");
  });

  it("a shell whose ttl + swr is under 60 s still reaches KV and is readable in the other colo", async () => {
    const a = createColo();
    const b = createColo();

    expect(await putShell(a, shellEntry("short"), 30, 0)).toBe("stored");

    expect(kv.entryKeys()).toHaveLength(1);
    expect(await readShell(b)).toBe("short");
  });
});

const SECOND_TAG = "promo";

describe.each(families)(
  "CFCacheStore with KV: the fall-through under the default memo settings and a request context, $name",
  (family) => {
    const read = async (colo: Colo): Promise<string | null> =>
      (await request(colo, family.read))?.content ?? null;

    it("serves the warmed entry from KV with the isolate memos on", async () => {
      // `memo: {}` is the store's defaults (shell memo 2 s, marker memo 1 s):
      // the other cases turn both off.
      const a = createColo({ memo: {} });
      const b = createColo({ memo: {} });
      await request(a, (store) => family.write(store, "v1"));
      later();
      expect(await read(b)).toBe("v1");
      later();
      await request(a, () => updateTag(TAG));
      later();
      await request(a, (store) => family.write(store, "v2"));
      later();
      kv.takeReads();

      expect(await read(b)).toBe("v2");
      expect(kv.takeReads().entries).toHaveLength(1);
      expect(await read(b)).toBe("v2");
      expect(kv.takeReads().entries).toEqual([]);
    });
  },
);

describe("CFCacheStore with KV: the shell fall-through under the default memo settings and a request context", () => {
  it("serves the warmed shell from KV with the isolate memos on", async () => {
    const a = createColo({ memo: {} });
    const b = createColo({ memo: {} });
    await request(a, (store) =>
      store.putShell(SHELL_KEY, shellEntry("v1"), 300, 0, [TAG]),
    );
    later();
    expect(await readShell(b)).toBe("v1");
    later();
    await request(a, () => updateTag(TAG));
    later();
    await request(a, (store) =>
      store.putShell(SHELL_KEY, shellEntry("v2"), 300, 0, [TAG]),
    );
    later();
    kv.takeReads();

    expect(await readShell(b)).toBe("v2");
    expect(await readShell(b)).toBe("v2");
  });
});

describe("CFCacheStore with KV: a KV entry carrying a second tag invalidated after it was written", () => {
  const twoTagFamilies: Array<{
    name: string;
    write(store: CFCacheStore, content: string): Promise<void>;
    read(store: CFCacheStore): Promise<unknown>;
  }> = [
    {
      name: "segment (get)",
      write: (store, content) =>
        store.set(
          KEY,
          { ...segmentEntry(content), tags: [TAG, SECOND_TAG] },
          300,
        ),
      read: async (store) => servedSegment(await store.get(KEY)),
    },
    {
      name: '"use cache" item (getItem)',
      write: (store, content) =>
        store.setItem(KEY, content, { ttl: 300, tags: [TAG, SECOND_TAG] }),
      read: async (store) => (await store.getItem(KEY))?.value ?? null,
    },
  ];

  it.each(twoTagFamilies)(
    "is refused, $name: the first tag's marker predates the entry, the second does not",
    async (family) => {
      const a = createColo();
      const b = createColo();
      await request(a, (store) => family.write(store, "v1"));
      later();
      expect(await request(b, family.read)).toBe("v1");
      later();
      await request(a, () => updateTag(TAG));
      later();
      await request(a, (store) => family.write(store, "v2"));
      later();
      // Written after TAG's marker, before SECOND_TAG's.
      await request(a, () => updateTag(SECOND_TAG));
      later();
      kv.takeReads();

      expect(await request(b, family.read)).toBeNull();
      expect(kv.takeReads().entries).toHaveLength(1);
    },
  );
});

describe("CFCacheStore with KV: what the fall-through costs and what it can serve", () => {
  it("N concurrent readers of one rejected copy each read the entry's KV key: nothing coalesces them", async () => {
    const a = createColo();
    const b = createColo();
    await request(a, (store) => store.set(KEY, segmentEntry("v1"), 300));
    later();
    expect(await readSegment(b)).toBe("v1");
    later();
    await request(a, () => updateTag(TAG));
    later();
    kv.takeReads();

    const readers = 5;
    const served = await Promise.all(
      Array.from({ length: readers }, () => readSegment(b)),
    );

    expect(served).toEqual(Array(readers).fill(null));
    // One KV get per miss, the count `main` had for a colo with no copy.
    expect(kv.takeReads().entries).toHaveLength(readers);
  });

  it("a late write (stamped after the marker with content from before it) is served and promoted by the colo that held a rejected copy", async () => {
    // Known hole, issue #1068: the data families stamp `taggedAt` at write
    // time, so a render that started before the invalidation and stored
    // after it passes the marker check. On main this colo re-rendered and its
    // write replaced the late entry; now it serves and promotes it. Delete
    // this case together with the hole.
    const a = createColo();
    const b = createColo();
    await request(a, (store) => store.set(KEY, segmentEntry("v1"), 300));
    later();
    expect(await readSegment(b)).toBe("v1");
    later();
    await request(a, () => updateTag(TAG));
    later();
    // The late write: bypasses the cache layers' predatesInvalidation gate.
    await request(a, (store) => store.set(KEY, segmentEntry("late"), 300));
    later();

    expect(await readSegment(b)).toBe("late");
    expect(await readSegment(b)).toBe("late");
  });
});
