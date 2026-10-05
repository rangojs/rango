/**
 * The global-refresh sequence documented for a `router.prerender()` warm on
 * CFCacheStore with KV (docs/design/prerender-every-route.md, "What the stores
 * cannot do in place: other edge locations"), seen from more than one edge
 * location: `updateTag(tag)`, then the warm's write.
 *
 * What this shows: the store's read flow across CFCacheStore instances that
 * share ONE KV and each have their OWN Cache API (L1).
 * - An L1 hit never reads the entry's KV key, so a colo keeps serving its own
 *   copy until that copy expires, whatever another colo wrote to KV since. A
 *   warm that replaces an entry is therefore not a cross-colo refresh.
 * - A tag marker in KV makes an older L1 copy unservable in every colo.
 * - A read that misses L1 finds the KV entry and promotes it. So after
 *   updateTag and the warm's write, a colo with no copy of its own (or whose
 *   copy a tagPurge evicted) reads the warmed entry.
 * - A colo that still holds its invalidated copy answers a miss and renders
 *   for itself: get() and the shell read do not fall through to the fresher
 *   KV entry (cf-cache-store.ts get(), "Tag invalidation": a deferred
 *   follow-up). It never serves the old copy.
 *
 * What it cannot show, because it is platform behavior and not store code:
 * - Cloudflare KV's propagation delay (a write "may take up to 60 seconds or
 *   more to be visible in other global network locations"). The KV here is
 *   one Map: a put is visible to every colo at once, the marker included.
 * - The Cache API's real per-colo isolation and eviction, and a real
 *   purge-by-tag. A colo here is a Map the `caches` stub switches to for the
 *   length of one request; the purge is a loop over those Maps.
 * - The isolate memo windows (cfShellMemo and cfMarkerMemo in
 *   cf-cache-store.ts). They are module-level, so the stores of one test
 *   process share one "isolate" and one colo's memo would answer another
 *   colo's read. Every store here turns them off
 *   (`memo: { shellMs: 0, markerFreshMs: 0 }`) and beforeEach resets them, so
 *   each read below is an L1 or a KV read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CFCacheStore,
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
  createRequestContext,
  runWithRequestContext,
} from "../../../server/request-context.js";
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

  async match(request: Request): Promise<Response | undefined> {
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

  async get(key: string, options?: { type?: string }): Promise<unknown> {
    this.reads.push(key);
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

  /** Entry keys read since the last call (tag-marker reads left out). */
  takeEntryReads(): string[] {
    return this.reads
      .splice(0)
      .filter((key) => !key.includes(TAG_MARKER_PREFIX));
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
  options: { tagPurge?: (cacheTags: string[]) => Promise<void> } = {},
): Colo {
  const pending: Promise<unknown>[] = [];
  const colo: Colo = {
    l1: new ColoCache(),
    store: new CFCacheStore({
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
      ...options,
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

  it("updateTag then the warm's write: a colo holding the old L1 copy stops serving it", async () => {
    const { a, b } = await bothColosHoldV1();
    await updateTagThenWarm(a);

    // Only "not the old copy" is pinned: get() answers an invalidated L1 hit
    // without reading the entry's KV key (cf-cache-store.ts get(), "Tag
    // invalidation"), so what this colo serves next is its own render, not
    // the warm's entry.
    expect(await readSegment(b)).not.toBe("v1");
    expect(await readSegment(a)).toBe("v2");
  });

  it("updateTag then the warm's write, with tagPurge: the purge evicts the other colo's copy and its next read is the warmed entry", async () => {
    const { a, b } = await bothColosHoldV1({ tagPurge: purgeEveryColo });
    await updateTagThenWarm(a);

    expect(b.l1.size).toBe(0);
    kv.takeEntryReads();
    expect(await readSegment(b)).toBe("v2");
    expect(kv.takeEntryReads()).toHaveLength(1);
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

  it("updateTag then the warm's write: a colo holding the old L1 copy stops serving it", async () => {
    const { a, b } = await bothColosHoldV1();
    await updateTagThenWarm(a);

    // As for a segment: readShellDocumentWithin answers an invalidated L1
    // shell without reading KV, so only "not the old copy" is pinned.
    expect(await readShell(b)).not.toBe("v1");
    expect(await readShell(a)).toBe("v2");
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
