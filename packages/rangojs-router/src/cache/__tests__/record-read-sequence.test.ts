/**
 * What one record read returns, which debug events it emits in which order,
 * which errors it reports, and which tiers still hold the entry after it:
 * per store (memory, Vercel, Cloudflare with and without KV), per family
 * (segment `get`, item `getItem`, response `getResponse`, and the shell
 * family's `getShell`, its passive form and `readShellDocument`) and per
 * outcome (hit, miss, corrupt, a read after a corrupt one, expired, masked,
 * stale, read error, and the Cloudflare tiers' own degradations).
 *
 * Each store keeps its own read path today; one shared record read must
 * reproduce every row. The debug events follow the order of the store's
 * I/O, so a reordered read shows here.
 *
 * Only the platform backends are faked (Vercel's runtime cache, the Cache
 * API, KV), each dropping an entry once its TTL has passed, as the platform
 * does. The memory store keeps live objects: it has no stored bytes to
 * corrupt and no backend read to fail, so it has no rows for those.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemorySegmentCacheStore } from "../memory-segment-store.js";
import {
  VercelCacheStore,
  type VercelCacheReadDebugEvent,
  type VercelRuntimeCache,
} from "../vercel/vercel-cache-store.js";
import {
  CFCacheStore,
  type CFCacheReadDebugEvent,
  type KVNamespace,
} from "../cf/cf-cache-store.js";
import {
  CACHE_READ_ERROR,
  type CachedEntryData,
  type SegmentCacheStore,
  type ShellCacheEntry,
  type ShellSnapshotRecord,
} from "../types.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../server/request-context.js";
import { revalidateTag } from "../tag-invalidation.js";

const T0 = 1_700_000_000_000;
const TTL = 60;
const SWR = 300;
/** Past the ttl, inside the swr window. */
const STALE_AT = T0 + (TTL + 1) * 1000;
/** Past ttl + swr. */
const EXPIRED_AT = T0 + (TTL + SWR + 40) * 1000;

type Family =
  | "segment"
  | "item"
  | "response"
  /** getShell, which claims a stale shell's revalidation. */
  | "shell"
  /** getShell(key, { claimRevalidation: false }). */
  | "shell passive"
  /** readShellDocument, the document serve path's read. */
  | "shell document";

// ---------------------------------------------------------------------------
// Platform backends
// ---------------------------------------------------------------------------

/** Vercel's runtime cache: JSON round-trips values, honors ttl. */
class FakeRuntimeCache implements VercelRuntimeCache {
  readonly values = new Map<
    string,
    { value: unknown; until: number; tags: string[] }
  >();
  readonly failing = new Set<string>();
  async get(key: string): Promise<unknown> {
    if (this.failing.has(key)) throw new Error("runtime cache down");
    const entry = this.values.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.until) {
      this.values.delete(key);
      return undefined;
    }
    return JSON.parse(JSON.stringify(entry.value));
  }
  async set(
    key: string,
    value: unknown,
    options?: { ttl?: number; tags?: string[] },
  ): Promise<void> {
    this.values.set(key, {
      value: JSON.parse(JSON.stringify(value)),
      until: Date.now() + (options?.ttl ?? 1e9) * 1000,
      tags: options?.tags ?? [],
    });
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
  async expireTag(tag: string | string[]): Promise<void> {
    const tags = Array.isArray(tag) ? tag : [tag];
    for (const [key, entry] of this.values) {
      if (entry.tags.some((t) => tags.includes(t))) this.values.delete(key);
    }
  }
}

/** The Cache API: entries live for the max-age they were put with. */
class FakeCache {
  readonly entries = new Map<string, { response: Response; until: number }>();
  readonly failing = new Set<string>();
  readonly stalled = new Set<string>();
  async match(request: Request): Promise<Response | undefined> {
    if (this.failing.has(request.url)) throw new Error("cache api down");
    if (this.stalled.has(request.url)) return new Promise(() => {});
    const entry = this.entries.get(request.url);
    if (!entry) return undefined;
    if (Date.now() >= entry.until) {
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
      response: new Response(await response.arrayBuffer(), response),
      until: Date.now() + (maxAge ? Number(maxAge[1]) : 1e9) * 1000,
    });
  }
  async delete(request: Request): Promise<boolean> {
    return this.entries.delete(request.url);
  }
}

class FakeCaches {
  readonly default = new FakeCache();
  async open(): Promise<FakeCache> {
    return this.default;
  }
}

/** KV: string values, honors expirationTtl. */
class FakeKV implements KVNamespace {
  readonly values = new Map<string, { value: string; until: number }>();
  readonly failing = new Set<string>();
  readonly stalled = new Set<string>();
  async get(key: string, options?: { type?: string }): Promise<any> {
    if (this.failing.has(key)) throw new Error("kv down");
    if (this.stalled.has(key)) return new Promise(() => {});
    const entry = this.values.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.until) {
      this.values.delete(key);
      return null;
    }
    return options?.type === "json" ? JSON.parse(entry.value) : entry.value;
  }
  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void> {
    this.values.set(key, {
      value,
      until: Date.now() + (options?.expirationTtl ?? 1e9) * 1000,
    });
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Stores under test
// ---------------------------------------------------------------------------

/**
 * A store over fresh backends. `tiers` maps a tier name to the backend keys
 * of one logical entry (absent for the memory store, whose maps are its own
 * state, not a backend); `control` reaches those keys to break them.
 */
interface Harness {
  store: SegmentCacheStore;
  events: string[];
  /** Background work (waitUntil) to settle before the next step. */
  pending: Promise<unknown>[];
  tiers?(family: Family, key: string): Record<string, string[]>;
  control: Partial<Record<Control, (family: Family, key: string) => void>>;
}

type Control =
  | "corrupt"
  | "failReads"
  | "stallLookup"
  | "stallBody"
  | "non200"
  | "loseL1"
  | "corruptKv"
  | "failKv"
  | "stallKv";

function memoryHarness(): Harness {
  return {
    store: new MemorySegmentCacheStore(),
    events: [],
    pending: [],
    control: {},
  };
}

function vercelHarness(): Harness {
  const cache = new FakeRuntimeCache();
  const events: string[] = [];
  const code: Record<Family, string> = {
    segment: "s",
    item: "i",
    response: "r",
    shell: "h",
    "shell passive": "h",
    "shell document": "h",
  };
  const keysOf = (family: Family, key: string): string[] =>
    [...cache.values.keys()].filter((k) =>
      k.endsWith(`rg:${code[family]}:${key}`),
    );
  return {
    store: new VercelCacheStore({
      cache,
      debug: (event: VercelCacheReadDebugEvent) =>
        events.push(`${event.op}:${event.outcome}`),
    }),
    events,
    pending: [],
    tiers: (family, key) => ({ "runtime cache": keysOf(family, key) }),
    control: {
      corrupt: (family, key) => {
        for (const k of keysOf(family, key)) {
          cache.values.get(k)!.value = "not json";
        }
      },
      failReads: (family, key) => {
        for (const k of keysOf(family, key)) cache.failing.add(k);
      },
    },
  };
}

/** How the Cloudflare store marks a family's keys. */
const CF_MARK: Record<Family, string> = {
  segment: "",
  item: "fn:",
  response: "doc:",
  shell: "shell2:",
  "shell passive": "shell2:",
  "shell document": "shell2:",
};

function cfHarness(withKv: boolean): Harness {
  const caches = new FakeCaches();
  vi.stubGlobal("caches", caches);
  const l1 = caches.default;
  const kv = withKv ? new FakeKV() : undefined;
  const events: string[] = [];
  const pending: Promise<unknown>[] = [];
  // Cache API URLs end with the encoded key (keyToRequest); KV keys with the
  // raw one (toKVKey, toDocKVKey).
  const l1Keys = (family: Family, key: string): string[] =>
    [...l1.entries.keys()].filter((url) =>
      url.endsWith(`/${encodeURIComponent(CF_MARK[family] + key)}`),
    );
  const kvKeys = (family: Family, key: string): string[] =>
    kv
      ? [...kv.values.keys()].filter((k) => k.endsWith(CF_MARK[family] + key))
      : [];
  const replaceL1 = (
    family: Family,
    key: string,
    build: (stored: Response) => Response,
  ): void => {
    for (const url of l1Keys(family, key)) {
      const entry = l1.entries.get(url)!;
      l1.entries.set(url, { ...entry, response: build(entry.response) });
    }
  };
  const control: Harness["control"] = {
    corrupt: (family, key) =>
      replaceL1(family, key, (stored) => new Response("not json", stored)),
    failReads: (family, key) => {
      for (const url of l1Keys(family, key)) l1.failing.add(url);
    },
    stallLookup: (family, key) => {
      for (const url of l1Keys(family, key)) l1.stalled.add(url);
    },
    stallBody: (family, key) =>
      replaceL1(
        family,
        key,
        (stored) => new Response(new ReadableStream({ start() {} }), stored),
      ),
    non200: (family, key) =>
      replaceL1(
        family,
        key,
        (stored) =>
          new Response("error", { status: 500, headers: stored.headers }),
      ),
  };
  if (kv) {
    Object.assign(control, {
      loseL1: (family: Family, key: string) => {
        for (const url of l1Keys(family, key)) l1.entries.delete(url);
      },
      corruptKv: (family: Family, key: string) => {
        for (const k of kvKeys(family, key)) kv.values.get(k)!.value = "{";
      },
      failKv: (family: Family, key: string) => {
        for (const k of kvKeys(family, key)) kv.failing.add(k);
      },
      stallKv: (family: Family, key: string) => {
        for (const k of kvKeys(family, key)) kv.stalled.add(k);
      },
    });
  }
  return {
    store: new CFCacheStore({
      ctx: {
        waitUntil: (promise: Promise<unknown>) => {
          pending.push(promise);
        },
        passThroughOnException: () => {},
      },
      kv,
      debug: (event: CFCacheReadDebugEvent) =>
        events.push(`${event.op}:${event.outcome}`),
    }),
    events,
    pending,
    tiers: (family, key) => ({
      L1: l1Keys(family, key),
      ...(kv ? { KV: kvKeys(family, key) } : {}),
    }),
    control,
  };
}

const STORES = {
  memory: memoryHarness,
  vercel: vercelHarness,
  cf: () => cfHarness(false),
  "cf+kv": () => cfHarness(true),
} as const;
type StoreName = keyof typeof STORES;

// ---------------------------------------------------------------------------
// One read
// ---------------------------------------------------------------------------

const STALLED = Symbol("stalled");

/**
 * Runs the fake clock forward until `promise` settles, past every latency
 * budget of the Cloudflare store, and gives up after a second of it: a
 * stalled backend read never settles, and the store abandons it once its
 * budget has passed.
 */
async function within<T>(promise: Promise<T>): Promise<T | typeof STALLED> {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let ms = 0; !settled && ms < 1000; ms += 10) {
    await vi.advanceTimersByTimeAsync(10);
  }
  return settled ? promise : STALLED;
}

/** Settles the background work (waitUntil) a step left. */
async function settle(h: Harness): Promise<void> {
  while (h.pending.length > 0) {
    await within(Promise.allSettled(h.pending.splice(0)));
  }
  await vi.advanceTimersByTimeAsync(0);
}

async function write(
  h: Harness,
  family: Family,
  key: string,
  tag: string,
): Promise<void> {
  if (family === "segment") {
    const data: CachedEntryData = {
      segments: [],
      handles: "h1",
      expiresAt: 0,
      tags: [tag],
    };
    await h.store.set(key, data, TTL, SWR);
  } else if (family === "item") {
    await h.store.setItem!(key, "v1", { ttl: TTL, swr: SWR, tags: [tag] });
  } else if (family === "response") {
    await h.store.putResponse!(key, new Response("r1"), TTL, SWR, [tag]);
  } else {
    const entry: ShellCacheEntry = {
      prelude: btoa("p1"),
      postponed: null,
      reactVersion: "react",
      buildVersion: "build",
      // The doc record a HIT replays the handler layer from.
      snapshot: [
        {
          family: "segment",
          key: "doc",
          value: { segments: [], handles: "h1", expiresAt: 0 },
        },
      ],
      docKey: "doc",
      createdAt: Date.now(),
    };
    await h.store.putShell!(key, entry, TTL, SWR, [tag]);
  }
  await settle(h);
}

/** A shell's snapshot, named when it is not the doc record written. */
function snapshotOf(snapshot: ShellSnapshotRecord[] | undefined): string {
  const keys = snapshot?.map((record) => record.key).join();
  return keys === "doc" ? "" : `, snapshot ${JSON.stringify(keys ?? null)}`;
}

/** What the caller gets; a hit's value is named when it is not the one written. */
async function read(h: Harness, family: Family, key: string): Promise<string> {
  let result: { shouldRevalidate?: boolean } | null;
  let value = "";
  if (family === "segment") {
    const got = await within(h.store.get(key));
    if (got === STALLED) return "stalled";
    if (got === CACHE_READ_ERROR) return "read-error";
    result = got;
    if (got && got.data.handles !== "h1") {
      value = `, handles ${JSON.stringify(got.data.handles)}`;
    }
  } else if (family === "item") {
    const got = await within(h.store.getItem!(key));
    if (got === STALLED) return "stalled";
    result = got;
    if (got && got.value !== "v1") value = `, value ${got.value}`;
  } else if (family === "response") {
    const got = await within(h.store.getResponse!(key));
    if (got === STALLED) return "stalled";
    result = got;
    // The caller streams the body: a stalled one is the caller's to wait on.
    const body = got ? await within(got.response.text()) : "r1";
    if (body === STALLED) value = ", body stalls";
    else if (body !== "r1") value = `, body ${JSON.stringify(body)}`;
  } else if (family === "shell document") {
    const got = await within(h.store.readShellDocument!(key));
    if (got === STALLED) return "stalled";
    result = got;
    if (got) {
      const prelude = new TextDecoder().decode(got.prelude);
      if (prelude !== "p1") value = `, prelude ${JSON.stringify(prelude)}`;
      value += snapshotOf(await got.snapshot);
    }
  } else {
    const got = await within(
      h.store.getShell!(
        key,
        family === "shell passive" ? { claimRevalidation: false } : undefined,
      ),
    );
    if (got === STALLED) return "stalled";
    result = got;
    if (got) {
      if (got.entry.prelude !== btoa("p1")) {
        value = `, prelude ${JSON.stringify(got.entry.prelude)}`;
      }
      value += snapshotOf(got.entry.snapshot);
    }
  }
  if (!result) return "miss";
  return (result.shouldRevalidate ? "hit, revalidate" : "hit") + value;
}

/** A request context on `store` whose onError records categories. */
function requestOn(store: SegmentCacheStore, reported: string[]) {
  const ctx = createRequestContext({
    env: {},
    request: new Request("https://example.com/p"),
    url: new URL("https://example.com/p"),
    variables: {},
    cacheStore: store,
  });
  ctx._reportBackgroundError = (_error, category) => {
    reported.push(category);
  };
  return ctx;
}

type CaseStep = (
  h: Harness,
  family: Family,
  key: string,
  tag: string,
) => void | Promise<void>;

/** What each case does to the stored entry (or the clock) before the read. */
const CASES = {
  hit: () => {},
  miss: () => {},
  corrupt: (h, family, key) => h.control.corrupt!(family, key),
  "corrupt, read again": async (h, family, key) => {
    // The read after the read that found the entry corrupt: what it healed.
    h.control.corrupt!(family, key);
    await read(h, family, key);
    await settle(h);
    h.events.length = 0;
  },
  expired: () => {
    vi.setSystemTime(EXPIRED_AT);
  },
  masked: (_h, _family, _key, tag) => {
    // This request invalidated the entry's tag.
    vi.setSystemTime(Date.now() + 100);
    revalidateTag(tag);
  },
  stale: () => {
    vi.setSystemTime(STALE_AT);
  },
  "stale, read again": async (h, family, key) => {
    // The read after a stale read that claimed the revalidation.
    vi.setSystemTime(STALE_AT);
    await read(h, family, key);
    await settle(h);
    h.events.length = 0;
  },
  "read error": (h, family, key) => h.control.failReads!(family, key),
  "slow lookup": (h, family, key) => h.control.stallLookup!(family, key),
  "slow body": (h, family, key) => h.control.stallBody!(family, key),
  "non-200": (h, family, key) => h.control.non200!(family, key),
  "L1 lost, KV hit": (h, family, key) => h.control.loseL1!(family, key),
  "L1 lost, KV stale": (h, family, key) => {
    h.control.loseL1!(family, key);
    vi.setSystemTime(STALE_AT);
  },
  "L1 lost, KV corrupt": (h, family, key) => {
    h.control.loseL1!(family, key);
    h.control.corruptKv!(family, key);
  },
  "L1 lost, KV read error": (h, family, key) => {
    h.control.loseL1!(family, key);
    h.control.failKv!(family, key);
  },
  "L1 lost, KV slow": (h, family, key) => {
    h.control.loseL1!(family, key);
    h.control.stallKv!(family, key);
  },
} satisfies Record<string, CaseStep>;
type Case = keyof typeof CASES;

const DEBUG_OP: Record<Family, string> = {
  segment: "get",
  item: "getItem",
  response: "getResponse",
  shell: "getShell",
  "shell passive": "getShell",
  "shell document": "getShell",
};

let tagSeq = 0;

/**
 * Runs `name` on a fresh store and observes its read as four cells: the
 * read, its debug events (an event of the family's own read op without its
 * op), the reported categories and the tiers holding the entry.
 */
async function observe(
  storeName: StoreName,
  family: Family,
  name: Case,
): Promise<string[]> {
  vi.setSystemTime(T0);
  const h = STORES[storeName]();
  // A tag and a key of its own: the Cloudflare marker and shell memos live
  // per isolate.
  const tag = `t${++tagSeq}`;
  const key = `k${tagSeq}`;
  // An earlier request to the same URL wrote the entry (the Cloudflare store
  // derives its Cache API URLs from the request's host).
  if (name !== "miss") {
    await runWithRequestContext(requestOn(h.store, []), () =>
      write(h, family, key, tag),
    );
  }
  const reported: string[] = [];
  return runWithRequestContext(requestOn(h.store, reported), async () => {
    await (CASES[name] as CaseStep)(h, family, key, tag);
    reported.length = 0;
    const result = await read(h, family, key);
    await settle(h);
    const op = `${DEBUG_OP[family]}:`;
    const events = h.events.map((event) =>
      event.startsWith(op) ? event.slice(op.length) : event,
    );
    const held = h.tiers
      ? Object.entries(h.tiers(family, key))
          .filter(([, keys]) => keys.length > 0)
          .map(([tier]) => tier)
          .join("+") || "none"
      : "-";
    return [
      result,
      events.join(" > ") || "-",
      reported.join(", ") || "-",
      held,
    ];
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * One row per store, case and family:
 * `store | case | family | read | debug events | reported | held`.
 * - read: "hit", "hit, revalidate", "miss" or "read-error"; a hit whose
 *   value, handles, body, prelude or snapshot is not the one written names
 *   it.
 * - debug events: in emit order, `>` between them. The Cloudflare store
 *   emits none for a response or shell read.
 * - reported: the error categories the request's onError received.
 * - held: the backend tiers still holding the entry once the read settled.
 * `-` is nothing (and, under held, a store with no backend); `none` is no
 * tier holding the entry.
 */
const EXPECTED = `
memory | hit                    | segment        | hit                  | -                        | -             | -
memory | hit                    | item           | hit                  | -                        | -             | -
memory | hit                    | response       | hit                  | -                        | -             | -
memory | hit                    | shell          | hit                  | -                        | -             | -
memory | hit                    | shell passive  | hit                  | -                        | -             | -
memory | miss                   | segment        | miss                 | -                        | -             | -
memory | miss                   | item           | miss                 | -                        | -             | -
memory | miss                   | response       | miss                 | -                        | -             | -
memory | miss                   | shell          | miss                 | -                        | -             | -
memory | miss                   | shell passive  | miss                 | -                        | -             | -
memory | expired                | segment        | miss                 | -                        | -             | -
memory | expired                | item           | miss                 | -                        | -             | -
memory | expired                | response       | miss                 | -                        | -             | -
memory | expired                | shell          | miss                 | -                        | -             | -
memory | expired                | shell passive  | miss                 | -                        | -             | -
memory | masked                 | segment        | miss                 | -                        | -             | -
memory | masked                 | item           | miss                 | -                        | -             | -
memory | masked                 | response       | miss                 | -                        | -             | -
memory | masked                 | shell          | miss                 | -                        | -             | -
memory | masked                 | shell passive  | miss                 | -                        | -             | -
memory | stale                  | segment        | miss                 | -                        | -             | -
memory | stale                  | item           | hit, revalidate      | -                        | -             | -
memory | stale                  | response       | hit, revalidate      | -                        | -             | -
memory | stale                  | shell          | hit, revalidate      | -                        | -             | -
memory | stale                  | shell passive  | hit, revalidate      | -                        | -             | -
memory | stale, read again      | segment        | miss                 | -                        | -             | -
memory | stale, read again      | item           | hit, revalidate      | -                        | -             | -
memory | stale, read again      | response       | hit, revalidate      | -                        | -             | -
memory | stale, read again      | shell          | hit, revalidate      | -                        | -             | -
memory | stale, read again      | shell passive  | hit, revalidate      | -                        | -             | -
vercel | hit                    | segment        | hit                  | fresh                    | -             | runtime cache
vercel | hit                    | item           | hit                  | fresh                    | -             | runtime cache
vercel | hit                    | response       | hit                  | fresh                    | -             | runtime cache
vercel | hit                    | shell          | hit                  | fresh                    | -             | runtime cache
vercel | hit                    | shell passive  | hit                  | fresh                    | -             | runtime cache
vercel | hit                    | shell document | hit                  | fresh                    | -             | runtime cache
vercel | miss                   | segment        | miss                 | miss                     | -             | none
vercel | miss                   | item           | miss                 | miss                     | -             | none
vercel | miss                   | response       | miss                 | miss                     | -             | none
vercel | miss                   | shell          | miss                 | miss                     | -             | none
vercel | miss                   | shell passive  | miss                 | miss                     | -             | none
vercel | miss                   | shell document | miss                 | miss                     | -             | none
vercel | expired                | segment        | miss                 | miss                     | -             | none
vercel | expired                | item           | miss                 | miss                     | -             | none
vercel | expired                | response       | miss                 | miss                     | -             | none
vercel | expired                | shell          | miss                 | miss                     | -             | none
vercel | expired                | shell passive  | miss                 | miss                     | -             | none
vercel | expired                | shell document | miss                 | miss                     | -             | none
vercel | masked                 | segment        | miss                 | miss                     | -             | none
vercel | masked                 | item           | miss                 | miss                     | -             | none
vercel | masked                 | response       | miss                 | miss                     | -             | none
vercel | masked                 | shell          | miss                 | miss                     | -             | none
vercel | masked                 | shell passive  | miss                 | miss                     | -             | none
vercel | masked                 | shell document | miss                 | miss                     | -             | none
vercel | stale                  | segment        | hit, revalidate      | stale-revalidate         | -             | runtime cache
vercel | stale                  | item           | hit, revalidate      | stale-revalidate         | -             | runtime cache
vercel | stale                  | response       | hit, revalidate      | stale-revalidate         | -             | runtime cache
vercel | stale                  | shell          | hit, revalidate      | stale-revalidate         | -             | runtime cache
vercel | stale                  | shell passive  | hit, revalidate      | stale-revalidate         | -             | runtime cache
vercel | stale                  | shell document | hit, revalidate      | stale-revalidate         | -             | runtime cache
vercel | stale, read again      | segment        | hit                  | fresh                    | -             | runtime cache
vercel | stale, read again      | item           | hit                  | fresh                    | -             | runtime cache
vercel | stale, read again      | response       | hit                  | fresh                    | -             | runtime cache
vercel | stale, read again      | shell          | hit                  | fresh                    | -             | runtime cache
vercel | stale, read again      | shell passive  | hit, revalidate      | stale-revalidate         | -             | runtime cache
vercel | stale, read again      | shell document | hit                  | fresh                    | -             | runtime cache
vercel | corrupt                | segment        | miss                 | corrupt                  | cache-corrupt | none
vercel | corrupt                | item           | miss                 | corrupt                  | cache-corrupt | none
vercel | corrupt                | response       | miss                 | corrupt                  | cache-corrupt | none
vercel | corrupt                | shell          | miss                 | corrupt                  | cache-corrupt | none
vercel | corrupt                | shell passive  | miss                 | corrupt                  | cache-corrupt | none
vercel | corrupt                | shell document | miss                 | corrupt                  | cache-corrupt | none
vercel | corrupt, read again    | segment        | miss                 | miss                     | -             | none
vercel | corrupt, read again    | item           | miss                 | miss                     | -             | none
vercel | corrupt, read again    | response       | miss                 | miss                     | -             | none
vercel | corrupt, read again    | shell          | miss                 | miss                     | -             | none
vercel | corrupt, read again    | shell passive  | miss                 | miss                     | -             | none
vercel | corrupt, read again    | shell document | miss                 | miss                     | -             | none
vercel | read error             | segment        | read-error           | error                    | cache-read    | runtime cache
vercel | read error             | item           | miss                 | error                    | cache-read    | runtime cache
vercel | read error             | response       | miss                 | error                    | cache-read    | runtime cache
vercel | read error             | shell          | miss                 | error                    | cache-read    | runtime cache
vercel | read error             | shell passive  | miss                 | error                    | cache-read    | runtime cache
vercel | read error             | shell document | miss                 | error                    | cache-read    | runtime cache
cf     | hit                    | segment        | hit                  | l1-fresh                 | -             | L1
cf     | hit                    | item           | hit                  | l1-fresh                 | -             | L1
cf     | hit                    | response       | hit                  | -                        | -             | L1
cf     | hit                    | shell          | hit                  | -                        | -             | L1
cf     | hit                    | shell passive  | hit                  | -                        | -             | L1
cf     | hit                    | shell document | hit                  | -                        | -             | L1
cf     | miss                   | segment        | miss                 | l1-miss                  | -             | none
cf     | miss                   | item           | miss                 | l1-miss                  | -             | none
cf     | miss                   | response       | miss                 | -                        | -             | none
cf     | miss                   | shell          | miss                 | -                        | -             | none
cf     | miss                   | shell passive  | miss                 | -                        | -             | none
cf     | miss                   | shell document | miss                 | -                        | -             | none
cf     | expired                | segment        | miss                 | l1-miss                  | -             | none
cf     | expired                | item           | miss                 | l1-miss                  | -             | none
cf     | expired                | response       | miss                 | -                        | -             | none
cf     | expired                | shell          | miss                 | -                        | -             | none
cf     | expired                | shell passive  | miss                 | -                        | -             | none
cf     | expired                | shell document | miss                 | -                        | -             | none
cf     | masked                 | segment        | hit                  | l1-fresh                 | -             | L1
cf     | masked                 | item           | hit                  | l1-fresh                 | -             | L1
cf     | masked                 | response       | hit                  | -                        | -             | L1
cf     | masked                 | shell          | hit                  | -                        | -             | L1
cf     | masked                 | shell passive  | hit                  | -                        | -             | L1
cf     | masked                 | shell document | hit                  | -                        | -             | L1
cf     | stale                  | segment        | hit, revalidate      | l1-stale-revalidate      | -             | L1
cf     | stale                  | item           | hit, revalidate      | l1-stale-revalidate      | -             | L1
cf     | stale                  | response       | hit, revalidate      | -                        | -             | L1
cf     | stale                  | shell          | hit, revalidate      | -                        | -             | L1
cf     | stale                  | shell passive  | hit, revalidate      | -                        | -             | L1
cf     | stale                  | shell document | hit, revalidate      | -                        | -             | L1
cf     | stale, read again      | segment        | hit                  | l1-revalidating-guarded  | -             | L1
cf     | stale, read again      | item           | hit                  | l1-revalidating-guarded  | -             | L1
cf     | stale, read again      | response       | hit                  | -                        | -             | L1
cf     | stale, read again      | shell          | hit, revalidate      | -                        | -             | L1
cf     | stale, read again      | shell passive  | hit, revalidate      | -                        | -             | L1
cf     | stale, read again      | shell document | hit, revalidate      | -                        | -             | L1
cf     | corrupt                | segment        | miss                 | body-error               | cache-corrupt | none
cf     | corrupt                | item           | miss                 | body-error               | cache-corrupt | none
cf     | corrupt                | response       | hit, body "not json" | -                        | -             | L1
cf     | corrupt                | shell          | miss                 | -                        | cache-corrupt | none
cf     | corrupt                | shell passive  | miss                 | -                        | cache-corrupt | none
cf     | corrupt                | shell document | miss                 | -                        | cache-corrupt | none
cf     | corrupt, read again    | segment        | miss                 | l1-miss                  | -             | none
cf     | corrupt, read again    | item           | miss                 | l1-miss                  | -             | none
cf     | corrupt, read again    | response       | hit, body "not json" | -                        | -             | L1
cf     | corrupt, read again    | shell          | miss                 | -                        | -             | none
cf     | corrupt, read again    | shell passive  | miss                 | -                        | -             | none
cf     | corrupt, read again    | shell document | miss                 | -                        | -             | none
cf     | read error             | segment        | read-error           | match-error              | cache-read    | L1
cf     | read error             | item           | miss                 | match-error              | cache-read    | L1
cf     | read error             | response       | miss                 | -                        | cache-read    | L1
cf     | read error             | shell          | miss                 | -                        | cache-read    | L1
cf     | read error             | shell passive  | miss                 | -                        | cache-read    | L1
cf     | read error             | shell document | miss                 | -                        | cache-read    | L1
cf     | slow lookup            | segment        | miss                 | match-timeout            | -             | L1
cf     | slow lookup            | item           | miss                 | match-timeout            | -             | L1
cf     | slow lookup            | response       | miss                 | -                        | -             | L1
cf     | slow body              | segment        | miss                 | body-timeout             | -             | L1
cf     | slow body              | item           | miss                 | body-timeout             | -             | L1
cf     | slow body              | response       | hit, body stalls     | -                        | -             | L1
cf     | non-200                | segment        | miss                 | non-200                  | -             | L1
cf     | non-200                | item           | miss                 | non-200                  | -             | L1
cf     | non-200                | response       | miss                 | -                        | -             | L1
cf+kv  | hit                    | segment        | hit                  | l1-fresh                 | -             | L1+KV
cf+kv  | hit                    | item           | hit                  | l1-fresh                 | -             | L1+KV
cf+kv  | hit                    | response       | hit                  | -                        | -             | L1+KV
cf+kv  | hit                    | shell          | hit                  | -                        | -             | L1+KV
cf+kv  | hit                    | shell passive  | hit                  | -                        | -             | L1+KV
cf+kv  | hit                    | shell document | hit                  | -                        | -             | L1+KV
cf+kv  | miss                   | segment        | miss                 | l1-miss > kv-miss        | -             | none
cf+kv  | miss                   | item           | miss                 | l1-miss > kv-miss        | -             | none
cf+kv  | miss                   | response       | miss                 | -                        | -             | none
cf+kv  | miss                   | shell          | miss                 | -                        | -             | none
cf+kv  | miss                   | shell passive  | miss                 | -                        | -             | none
cf+kv  | miss                   | shell document | miss                 | -                        | -             | none
cf+kv  | expired                | segment        | miss                 | l1-miss > kv-miss        | -             | none
cf+kv  | expired                | item           | miss                 | l1-miss > kv-miss        | -             | none
cf+kv  | expired                | response       | miss                 | -                        | -             | none
cf+kv  | expired                | shell          | miss                 | -                        | -             | none
cf+kv  | expired                | shell passive  | miss                 | -                        | -             | none
cf+kv  | expired                | shell document | miss                 | -                        | -             | none
cf+kv  | masked                 | segment        | miss                 | tag-invalidated          | -             | L1+KV
cf+kv  | masked                 | item           | miss                 | tag-invalidated          | -             | L1+KV
cf+kv  | masked                 | response       | miss                 | -                        | -             | L1+KV
cf+kv  | masked                 | shell          | miss                 | -                        | -             | L1+KV
cf+kv  | masked                 | shell passive  | miss                 | -                        | -             | L1+KV
cf+kv  | masked                 | shell document | miss                 | -                        | -             | L1+KV
cf+kv  | stale                  | segment        | hit, revalidate      | l1-stale-revalidate      | -             | L1+KV
cf+kv  | stale                  | item           | hit, revalidate      | l1-stale-revalidate      | -             | L1+KV
cf+kv  | stale                  | response       | hit, revalidate      | -                        | -             | L1+KV
cf+kv  | stale                  | shell          | hit, revalidate      | -                        | -             | L1+KV
cf+kv  | stale                  | shell passive  | hit, revalidate      | -                        | -             | L1+KV
cf+kv  | stale                  | shell document | hit, revalidate      | -                        | -             | L1+KV
cf+kv  | stale, read again      | segment        | hit                  | l1-revalidating-guarded  | -             | L1+KV
cf+kv  | stale, read again      | item           | hit                  | l1-revalidating-guarded  | -             | L1+KV
cf+kv  | stale, read again      | response       | hit                  | -                        | -             | L1+KV
cf+kv  | stale, read again      | shell          | hit, revalidate      | -                        | -             | L1+KV
cf+kv  | stale, read again      | shell passive  | hit, revalidate      | -                        | -             | L1+KV
cf+kv  | stale, read again      | shell document | hit, revalidate      | -                        | -             | L1+KV
cf+kv  | corrupt                | segment        | hit                  | body-error > kv-fresh    | cache-corrupt | L1+KV
cf+kv  | corrupt                | item           | hit                  | body-error > kv-fresh    | cache-corrupt | L1+KV
cf+kv  | corrupt                | response       | hit, body "not json" | -                        | -             | L1+KV
cf+kv  | corrupt                | shell          | hit                  | -                        | cache-corrupt | L1+KV
cf+kv  | corrupt                | shell passive  | hit                  | -                        | cache-corrupt | L1+KV
cf+kv  | corrupt                | shell document | hit                  | -                        | cache-corrupt | L1+KV
cf+kv  | corrupt, read again    | segment        | hit                  | l1-fresh                 | -             | L1+KV
cf+kv  | corrupt, read again    | item           | hit                  | l1-fresh                 | -             | L1+KV
cf+kv  | corrupt, read again    | response       | hit, body "not json" | -                        | -             | L1+KV
cf+kv  | corrupt, read again    | shell          | hit                  | -                        | -             | L1+KV
cf+kv  | corrupt, read again    | shell passive  | hit                  | -                        | -             | L1+KV
cf+kv  | corrupt, read again    | shell document | hit                  | -                        | -             | L1+KV
cf+kv  | read error             | segment        | hit                  | match-error > kv-fresh   | cache-read    | L1+KV
cf+kv  | read error             | item           | hit                  | match-error > kv-fresh   | cache-read    | L1+KV
cf+kv  | read error             | response       | hit                  | -                        | cache-read    | L1+KV
cf+kv  | read error             | shell          | hit                  | -                        | cache-read    | L1+KV
cf+kv  | read error             | shell passive  | hit                  | -                        | cache-read    | L1+KV
cf+kv  | read error             | shell document | hit                  | -                        | cache-read    | L1+KV
cf+kv  | slow lookup            | segment        | hit                  | match-timeout > kv-fresh | -             | L1+KV
cf+kv  | slow lookup            | item           | hit                  | match-timeout > kv-fresh | -             | L1+KV
cf+kv  | slow lookup            | response       | hit                  | -                        | -             | L1+KV
cf+kv  | slow body              | segment        | hit                  | body-timeout > kv-fresh  | -             | L1+KV
cf+kv  | slow body              | item           | hit                  | body-timeout > kv-fresh  | -             | L1+KV
cf+kv  | slow body              | response       | hit, body stalls     | -                        | -             | L1+KV
cf+kv  | non-200                | segment        | hit                  | non-200 > kv-fresh       | -             | L1+KV
cf+kv  | non-200                | item           | hit                  | non-200 > kv-fresh       | -             | L1+KV
cf+kv  | non-200                | response       | hit                  | -                        | -             | L1+KV
cf+kv  | L1 lost, KV hit        | segment        | hit                  | l1-miss > kv-fresh       | -             | L1+KV
cf+kv  | L1 lost, KV hit        | item           | hit                  | l1-miss > kv-fresh       | -             | L1+KV
cf+kv  | L1 lost, KV hit        | response       | hit                  | -                        | -             | L1+KV
cf+kv  | L1 lost, KV stale      | segment        | hit, revalidate      | l1-miss > kv-stale       | -             | L1+KV
cf+kv  | L1 lost, KV stale      | item           | hit, revalidate      | l1-miss > kv-stale       | -             | L1+KV
cf+kv  | L1 lost, KV stale      | response       | hit, revalidate      | -                        | -             | L1+KV
cf+kv  | L1 lost, KV corrupt    | segment        | miss                 | l1-miss > kv-miss        | cache-corrupt | none
cf+kv  | L1 lost, KV corrupt    | item           | miss                 | l1-miss > kv-miss        | cache-corrupt | none
cf+kv  | L1 lost, KV corrupt    | response       | miss                 | -                        | cache-corrupt | none
cf+kv  | L1 lost, KV read error | segment        | read-error           | l1-miss > error          | cache-read    | KV
cf+kv  | L1 lost, KV read error | item           | miss                 | l1-miss > error          | cache-read    | KV
cf+kv  | L1 lost, KV read error | response       | miss                 | -                        | cache-read    | KV
cf+kv  | L1 lost, KV slow       | segment        | miss                 | l1-miss > kv-timeout     | -             | KV
cf+kv  | L1 lost, KV slow       | item           | miss                 | l1-miss > kv-timeout     | -             | KV
cf+kv  | L1 lost, KV slow       | response       | miss                 | -                        | -             | KV
`;

interface Row {
  store: StoreName;
  name: Case;
  family: Family;
  cells: string[];
}

const ROWS: Row[] = EXPECTED.trim()
  .split("\n")
  .map((line) => {
    const [store, name, family, ...cells] = line
      .split(" | ")
      .map((cell) => cell.trim());
    return {
      store: store as StoreName,
      name: name as Case,
      family: family as Family,
      cells,
    };
  });

/** The rows of one store and case, for one test. */
const GROUPS = [...new Set(ROWS.map((row) => `${row.store}, ${row.name}`))].map(
  (label) => ({
    label,
    rows: ROWS.filter((row) => `${row.store}, ${row.name}` === label),
  }),
);

describe("record reads: return value, debug events, reported errors and the tiers left holding the entry", () => {
  it.each(GROUPS)("$label", async ({ rows }) => {
    const seen: Record<string, string[]> = {};
    const expected: Record<string, string[]> = {};
    for (const { store, name, family, cells } of rows) {
      seen[family] = await observe(store, family, name);
      expected[family] = cells;
    }
    expect(seen).toEqual(expected);
  });
});
