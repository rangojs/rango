/**
 * Consumer dogfood for the PPR shell memo (issue #941): what an app can check
 * about its store's `memo` option with the public surface alone —
 * `@rangojs/router/cache` for the store and `shellCacheKey` from
 * `@rangojs/router/testing` for the key a document HIT reads.
 *
 * `dispatch` cannot drive a PPR shell HIT (no Flight/SSR commit point; see
 * testing/shell-status.ts), so the observable contract is the store's shell
 * family under the production key: a repeat read inside the window does not
 * touch the backing cache, `{ shellMs: 0 }` reads it every time, and an
 * invalidation of the shell's tag misses on the very next read.
 */
import { describe, it, expect } from "vitest";
import {
  VercelCacheStore,
  type VercelRuntimeCache,
} from "../../cache/index.js";
import { runInRequestContext, shellCacheKey } from "../index.js";
// The function `@rangojs/router` exports under the react-server condition.
import { updateTag } from "../../cache/tag-invalidation.js";

/** A counting in-memory stand-in for `getCache()` (one per process). */
function countingCache(
  values: Map<string, unknown> = new Map(),
  tags: Map<string, string[]> = new Map(),
): { cache: VercelRuntimeCache; reads: () => number } {
  let reads = 0;
  const cache: VercelRuntimeCache = {
    async get(key) {
      if (key.includes(":h:")) reads++;
      const value = values.get(key);
      return value === undefined
        ? undefined
        : JSON.parse(JSON.stringify(value));
    },
    async set(key, value, options) {
      values.set(key, JSON.parse(JSON.stringify(value)));
      tags.set(key, options?.tags ?? []);
    },
    async delete(key) {
      values.delete(key);
    },
    async expireTag(tag) {
      const expired = Array.isArray(tag) ? tag : [tag];
      for (const [key, keyTags] of tags) {
        if (keyTags.some((t) => expired.includes(t))) values.delete(key);
      }
    },
  };
  return { cache, reads: () => reads };
}

const SHELL = {
  prelude: btoa("<html><body>shell</body></html>"),
  postponed: null,
  reactVersion: "19.2.6",
  buildVersion: "app-build",
  snapshot: [],
};

describe("PPR shell memo through the public store API", () => {
  const key = shellCacheKey("https://shop.example.com/products/1?b=2&a=1");

  it("serves a repeat shell read from memory, and reads again with { shellMs: 0 }", async () => {
    const memoOn = countingCache();
    const on = new VercelCacheStore({ cache: memoOn.cache });
    await on.putShell(key, { ...SHELL, createdAt: Date.now() }, 60, 300);
    expect(await on.getShell(key)).not.toBeNull();
    expect(await on.getShell(key)).not.toBeNull();
    expect(memoOn.reads()).toBe(1);

    const memoOff = countingCache();
    const off = new VercelCacheStore({
      cache: memoOff.cache,
      memo: { shellMs: 0 },
    });
    await off.putShell(key, { ...SHELL, createdAt: Date.now() }, 60, 300);
    await off.getShell(key);
    await off.getShell(key);
    expect(memoOff.reads()).toBe(2);
  });

  it("misses on the read after the shell's tag is invalidated", async () => {
    const { cache } = countingCache();
    const store = new VercelCacheStore({ cache });
    await store.putShell(
      key,
      { ...SHELL, createdAt: Date.now() - 10 },
      60,
      300,
      ["product:1"],
    );
    expect(await store.getShell(key)).not.toBeNull();
    await store.invalidateTags(["product:1"]);
    expect(await store.getShell(key)).toBeNull();
  });

  // updateTag() on one process: the response sets the fresh-reads cookie, and
  // the same user's next request on ANOTHER process (whose memos predate the
  // mutation) reads past both memos. Other users are served the memoized
  // shell until the marker memo refreshes.
  it("after updateTag, a request carrying the fresh-reads cookie is fresh on another process", async () => {
    const values = new Map<string, unknown>();
    const tags = new Map<string, string[]>();
    const a = new VercelCacheStore({
      cache: countingCache(values, tags).cache,
    });
    const b = new VercelCacheStore({
      cache: countingCache(values, tags).cache,
    });
    await a.putShell(key, { ...SHELL, createdAt: Date.now() - 10 }, 60, 300, [
      "product:1",
    ]);
    const warm = await runInRequestContext(() => b.getShell(key), {
      cacheStore: b,
    });
    expect(warm.result).not.toBeNull();

    const mutation = await runInRequestContext(() => updateTag("product:1"), {
      cacheStore: a,
    });
    const fresh = mutation.response.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith("rango-state-fresh="));
    expect(fresh).toMatch(
      new RegExp(
        "^rango-state-fresh=1; Max-Age=3; Path=/; HttpOnly; SameSite=Lax",
      ),
    );

    const otherUser = await runInRequestContext(() => b.getShell(key), {
      cacheStore: b,
    });
    expect(otherUser.result).not.toBeNull();

    const sameUser = await runInRequestContext(() => b.getShell(key), {
      cacheStore: b,
      requestInit: {
        headers: { cookie: "rango-state-fresh=1" },
      },
    });
    expect(sameUser.result).toBeNull();
  });
});
