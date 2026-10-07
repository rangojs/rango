/**
 * The `ta` stamp on a Vercel data entry is the start of the execution that
 * produced it, not the write time (#1068). expireTag keeps no queryable
 * history, so `ta` is read by the request mask only: the invalidating request
 * must not read, as fresh, an entry its own invalidation covers whose render
 * started before the call.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  VercelCacheStore,
  type VercelRuntimeCache,
} from "../vercel-cache-store.js";
import type { CachedEntryData } from "../../types.js";
import { CACHE_READ_ERROR } from "../../types.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../../server/request-context.js";
import { markResponseStart, revalidateTag } from "../../tag-invalidation.js";

const T0 = 1_700_000_000_000;

function makeFakeCache(): VercelRuntimeCache {
  const values = new Map<string, { value: unknown; tags: string[] }>();
  return {
    async get(key) {
      const entry = values.get(key);
      return entry ? JSON.parse(JSON.stringify(entry.value)) : undefined;
    },
    async set(key, value, options) {
      values.set(key, {
        value: JSON.parse(JSON.stringify(value)),
        tags: options?.tags ?? [],
      });
    },
    async delete(key) {
      values.delete(key);
    },
    async expireTag(tag) {
      const tags = Array.isArray(tag) ? tag : [tag];
      for (const [key, entry] of values) {
        if (entry.tags.some((t) => tags.includes(t))) values.delete(key);
      }
    },
  };
}

function segment(tags: string[], taggedAt?: number): CachedEntryData {
  return {
    segments: [],
    handles: "",
    expiresAt: 0,
    tags,
    ...(taggedAt === undefined ? {} : { taggedAt }),
  };
}

/**
 * An entry's render started at T0; the request invalidates "x" at T0+100,
 * then the write lands at T0+200 inside the same request.
 */
async function lateWrite(
  write: (s: VercelCacheStore) => Promise<void>,
  read: (s: VercelCacheStore) => Promise<unknown>,
): Promise<unknown> {
  const cache = makeFakeCache();
  // expireTag would delete the entry; the stamp is what is under test.
  const set = cache.set.bind(cache);
  vi.spyOn(cache, "expireTag").mockImplementation(
    () => new Promise<void>(() => {}),
  );
  vi.spyOn(cache, "set").mockImplementation(async (key, value, options) => {
    if (key.startsWith("rg:tm:")) return new Promise<void>(() => {});
    return set(key, value, options);
  });
  const s = new VercelCacheStore({ cache });
  const req = createRequestContext({
    env: {},
    request: new Request("https://test.internal/p"),
    url: new URL("https://test.internal/p"),
    variables: {},
    cacheStore: s,
  });
  return runWithRequestContext(req, async () => {
    vi.setSystemTime(new Date(T0 + 100));
    revalidateTag("x");
    vi.setSystemTime(new Date(T0 + 200));
    await write(s);
    return read(s);
  });
}

const FAMILIES: {
  name: string;
  write: (s: VercelCacheStore, startedAt?: number) => Promise<void>;
  read: (s: VercelCacheStore) => Promise<unknown>;
}[] = [
  {
    name: "set",
    write: (s, at) => s.set("k", segment(["x"], at), 60),
    read: async (s) => {
      const r = await s.get("k");
      return r === CACHE_READ_ERROR ? null : r;
    },
  },
  {
    name: "setItem",
    write: (s, at) =>
      s.setItem("k", "v", { ttl: 60, tags: ["x"], startedAt: at }),
    read: (s) => s.getItem("k"),
  },
  {
    name: "putResponse",
    write: (s, at) => {
      const response = new Response("body");
      if (at !== undefined) markResponseStart(response, { seq: 0, at });
      return s.putResponse("k", response, 60, undefined, ["x"]);
    },
    read: (s) => s.getResponse("k"),
  },
];

describe.each(FAMILIES)(
  "VercelCacheStore $name stamps the execution start (#1068)",
  ({ write, read }) => {
    let consoleError: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(T0));
      consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => {
      consoleError.mockRestore();
      vi.useRealTimers();
    });

    it.each([
      ["started before the invalidation: masked", T0, false],
      ["started after the invalidation: served", T0 + 150, true],
      ["no known start (write time): served", undefined, true],
    ])("the invalidating request, %s", async (_label, startedAt, served) => {
      const result = await lateWrite((s) => write(s, startedAt), read);
      expect(result !== null).toBe(served);
    });
  },
);
