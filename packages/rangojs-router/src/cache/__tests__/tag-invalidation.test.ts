import { describe, it, expect, beforeEach, vi } from "vitest";
import { MemorySegmentCacheStore } from "../memory-segment-store.js";
import {
  executionStart,
  invalidatedSince,
  predatesInvalidation,
  updateTag,
  revalidateTag,
} from "../tag-invalidation.js";
import { resolveCacheStore } from "../cache-policy.js";
import type { SegmentCacheStore } from "../types.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../server/request-context.js";

function makeCtx(opts: {
  cacheStore?: SegmentCacheStore;
  explicitTaggedStores?: Set<SegmentCacheStore>;
}) {
  return createRequestContext({
    env: {},
    request: new Request("https://example.com/"),
    url: new URL("https://example.com/"),
    variables: {},
    cacheStore: opts.cacheStore,
    explicitTaggedStores: opts.explicitTaggedStores,
  });
}

describe("updateTag (read-your-own-writes)", () => {
  beforeEach(() => {
    MemorySegmentCacheStore.resetGlobalCache();
  });

  it("invalidates app-store entries and resolves after completion", async () => {
    const app = new MemorySegmentCacheStore();
    await app.setItem("k1", "v1", { ttl: 60, tags: ["products"] });
    await app.setItem("k2", "v2", { ttl: 60, tags: ["other"] });
    const ctx = makeCtx({ cacheStore: app });

    await runWithRequestContext(ctx, async () => {
      await updateTag("products");
      // Read-your-own-writes: fresh immediately after awaiting updateTag().
      expect(await app.getItem("k1")).toBeNull();
      expect(await app.getItem("k2")).not.toBeNull();
    });
  });

  it("fans out to explicit per-scope stores resolved during the request", async () => {
    const app = new MemorySegmentCacheStore();
    const custom = new MemorySegmentCacheStore();
    const explicitTaggedStores = new Set<SegmentCacheStore>();
    await custom.setItem("c1", "cv", { ttl: 60, tags: ["catalog"] });
    const ctx = makeCtx({ cacheStore: app, explicitTaggedStores });

    await runWithRequestContext(ctx, async () => {
      // Resolving the explicit store registers it (cache({ store: custom })).
      resolveCacheStore(custom);
      await updateTag("catalog");
      expect(await custom.getItem("c1")).toBeNull();
    });
  });

  it("attempts every store and rejects with a combined error when one store fails (allSettled)", async () => {
    // One store rejects (e.g. CFCacheStore on a failed durable marker write); the
    // other must still be invalidated, and updateTag must surface the failure
    // rather than short-circuit or silently report success.
    const failing = {
      get: async () => null,
      set: async () => {},
      delete: async () => false,
      invalidateTags: vi.fn().mockRejectedValue(new Error("KV unavailable")),
    } as unknown as SegmentCacheStore;
    const healthy = new MemorySegmentCacheStore();
    await healthy.setItem("k", "v", { ttl: 60, tags: ["products"] });

    const explicitTaggedStores = new Set<SegmentCacheStore>();
    const ctx = makeCtx({ cacheStore: failing, explicitTaggedStores });

    await runWithRequestContext(ctx, async () => {
      resolveCacheStore(healthy); // register the succeeding store
      await expect(updateTag("products")).rejects.toThrow(
        /failed to invalidate/,
      );
      // The healthy store was still invalidated (not short-circuited)...
      expect(await healthy.getItem("k")).toBeNull();
      // ...and the failing store was actually attempted.
      expect(failing.invalidateTags).toHaveBeenCalledTimes(1);
    });
  });

  it("is variadic across multiple tags", async () => {
    const app = new MemorySegmentCacheStore();
    await app.setItem("a", "1", { ttl: 60, tags: ["t1"] });
    await app.setItem("b", "2", { ttl: 60, tags: ["t2"] });
    await app.setItem("c", "3", { ttl: 60, tags: ["t3"] });
    const ctx = makeCtx({ cacheStore: app });

    await runWithRequestContext(ctx, async () => {
      await updateTag("t1", "t2");
      expect(await app.getItem("a")).toBeNull();
      expect(await app.getItem("b")).toBeNull();
      expect(await app.getItem("c")).not.toBeNull();
    });
  });

  it("warns (in every environment) and no-ops when no tag-capable store is configured", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = makeCtx({}); // no store at all

    await runWithRequestContext(ctx, async () => {
      await updateTag("products");
    });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("No tag-capable cache store"),
    );
    warn.mockRestore();
  });

  it("warns about, but does not skip silently, a configured store lacking invalidateTag", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // App store WITHOUT tag support; explicit per-scope store WITH it.
    const appStore = {
      async getItem() {
        return null;
      },
      async setItem() {},
    } as unknown as SegmentCacheStore;
    const explicit = new MemorySegmentCacheStore();
    const explicitTaggedStores = new Set<SegmentCacheStore>();
    await explicit.setItem("k", "v", { ttl: 60, tags: ["shared"] });
    const ctx = makeCtx({ cacheStore: appStore, explicitTaggedStores });

    await runWithRequestContext(ctx, async () => {
      resolveCacheStore(explicit); // register the explicit store
      await updateTag("shared");
      // The capable store IS invalidated...
      expect(await explicit.getItem("k")).toBeNull();
    });
    // ...and the non-tag-capable app store is surfaced, not silently ignored.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("do not implement"),
    );
    warn.mockRestore();
  });

  it("drops empty/whitespace tags without touching stores", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = new MemorySegmentCacheStore();
    await app.setItem("k", "v", { ttl: 60, tags: ["real"] });
    const ctx = makeCtx({ cacheStore: app });

    await runWithRequestContext(ctx, async () => {
      // Empty tags normalize away before the store check -> no-op, no warning.
      await updateTag("", "   ");
      expect(await app.getItem("k")).not.toBeNull();
      expect(warn).not.toHaveBeenCalled();

      await updateTag("real");
      expect(await app.getItem("k")).toBeNull();
    });
    warn.mockRestore();
  });
});

describe("revalidateTag (background hard-purge)", () => {
  beforeEach(() => {
    MemorySegmentCacheStore.resetGlobalCache();
  });

  it("schedules invalidation via ctx.waitUntil", async () => {
    const app = new MemorySegmentCacheStore();
    await app.setItem("k", "v", { ttl: 60, tags: ["products"] });
    const ctx = makeCtx({ cacheStore: app });

    let scheduled = 0;
    const originalWaitUntil = ctx.waitUntil.bind(ctx);
    ctx.waitUntil = (fn: () => Promise<void>) => {
      scheduled++;
      originalWaitUntil(fn);
    };

    await runWithRequestContext(ctx, async () => {
      revalidateTag("products");
    });

    expect(scheduled).toBe(1);
    // Memory store invalidateTag is synchronous; flush microtasks to be safe.
    await Promise.resolve();
    expect(await app.getItem("k")).toBeNull();
  });

  it("fans out across app + explicit stores, deduplicated", async () => {
    const app = new MemorySegmentCacheStore();
    const custom = new MemorySegmentCacheStore();
    const explicitTaggedStores = new Set<SegmentCacheStore>();
    await app.setItem("a", "1", { ttl: 60, tags: ["shared"] });
    await custom.setItem("c", "2", { ttl: 60, tags: ["shared"] });
    const ctx = makeCtx({ cacheStore: app, explicitTaggedStores });

    await runWithRequestContext(ctx, async () => {
      resolveCacheStore(custom);
      revalidateTag("shared");
    });

    await Promise.resolve();
    expect(await app.getItem("a")).toBeNull();
    expect(await custom.getItem("c")).toBeNull();
  });

  it("reports a failed background invalidation via onError (cache-invalidate) rather than swallowing it (#3)", async () => {
    // revalidateTag is fire-and-forget, so the only way a failed durable write
    // is observable is through onError. It runs in a detached waitUntil where the
    // ALS context is gone, so the captured ctx must be threaded to the reporter.
    const failing = {
      get: async () => null,
      set: async () => {},
      delete: async () => false,
      invalidateTags: vi.fn().mockRejectedValue(new Error("KV unavailable")),
    } as unknown as SegmentCacheStore;
    const ctx = makeCtx({ cacheStore: failing });

    const reported: Array<{ error: unknown; category: string }> = [];
    (ctx as unknown as Record<string, unknown>)._reportBackgroundError = (
      error: unknown,
      category: string,
    ) => reported.push({ error, category });

    // Capture the detached waitUntil task so the test can await it.
    const pending: Promise<unknown>[] = [];
    ctx.waitUntil = (fn: () => Promise<void>) => {
      pending.push(Promise.resolve().then(fn));
    };

    await runWithRequestContext(ctx, async () => {
      revalidateTag("products");
    });
    await Promise.all(pending);

    expect(failing.invalidateTags).toHaveBeenCalled();
    expect(reported.some((r) => r.category === "cache-invalidate")).toBe(true);
  });
});

// Issue #973: revalidateTag() calls every store's invalidateTags() before it
// returns, so what a store records before its first await masks the tags for
// the rest of the request; only the durable remainder runs in the background.
describe("revalidateTag: the invalidating request reads its own writes (#973)", () => {
  beforeEach(() => {
    MemorySegmentCacheStore.resetGlobalCache();
  });

  it("calls invalidateTags() before it returns and hands the pending write to waitUntil", async () => {
    let finish!: () => void;
    const durable = new Promise<void>((resolve) => (finish = resolve));
    const store = {
      get: async () => null,
      set: async () => {},
      delete: async () => false,
      invalidateTags: vi.fn(() => durable),
    } as unknown as SegmentCacheStore;
    const ctx = makeCtx({ cacheStore: store });
    const tasks: Array<() => Promise<void>> = [];
    ctx.waitUntil = (fn: () => Promise<void>) => {
      tasks.push(fn);
    };

    runWithRequestContext(ctx, () => {
      revalidateTag("products");
      expect(store.invalidateTags).toHaveBeenCalledWith(["products"]);
    });

    expect(tasks).toHaveLength(1);
    let settled = false;
    const task = tasks[0]!().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await task;
    expect(settled).toBe(true);
  });

  it("a build-time render still runs no invalidation (its waitUntil drops background work)", () => {
    const store = {
      get: async () => null,
      set: async () => {},
      delete: async () => false,
      invalidateTags: vi.fn(async () => {}),
    } as unknown as SegmentCacheStore;
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com/"),
      url: new URL("https://example.com/"),
      variables: {},
      cacheStore: store,
      build: true,
    });

    runWithRequestContext(ctx, () => revalidateTag("products"));

    expect(store.invalidateTags).not.toHaveBeenCalled();
  });

  it("MemorySegmentCacheStore: a read in the same tick misses", async () => {
    const app = new MemorySegmentCacheStore();
    await app.setItem("item", "v", { ttl: 60, tags: ["products"] });
    await app.set(
      "seg",
      { segments: [], handles: "", expiresAt: 0, tags: ["products"] },
      60,
    );
    const ctx = makeCtx({ cacheStore: app });

    const [item, seg] = await runWithRequestContext(ctx, () => {
      revalidateTag("products");
      // Called synchronously: no microtask has run since revalidateTag().
      return Promise.all([app.getItem("item"), app.get("seg")]);
    });
    expect(item).toBeNull();
    expect(seg).toBeNull();
  });

  it("MemorySegmentCacheStore: a read after a prior read in the request misses", async () => {
    const app = new MemorySegmentCacheStore();
    await app.setItem("item", "v", { ttl: 60, tags: ["products"] });
    const ctx = makeCtx({ cacheStore: app });

    await runWithRequestContext(ctx, async () => {
      expect(await app.getItem("item")).not.toBeNull();
      revalidateTag("products");
      expect(await app.getItem("item")).toBeNull();
    });
  });
});

describe("the write gate: an execution that started before an invalidation (#977)", () => {
  const withStore = (store: SegmentCacheStore) =>
    makeCtx({ cacheStore: store });
  const invalidateIn = (store: SegmentCacheStore, ...tags: string[]) =>
    runWithRequestContext(withStore(store), () => updateTag(...tags));

  it("sees another request's invalidation, not only the calling one's", async () => {
    const store = new MemorySegmentCacheStore();
    const start = executionStart();
    await invalidateIn(store, "gate-other-request");

    expect(invalidatedSince(["gate-other-request"], start.seq)).toBe(true);
    expect(invalidatedSince(["gate-untouched"], start.seq)).toBe(false);
    expect(
      await predatesInvalidation(store, ["gate-other-request"], start),
    ).toBe(true);
  });

  it("an invalidation before the start does not count, in the same millisecond too", async () => {
    const store = new MemorySegmentCacheStore();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await invalidateIn(store, "gate-before");
      const start = executionStart();
      expect(invalidatedSince(["gate-before"], start.seq)).toBe(false);
      // The store saw the invalidation in the start's millisecond: asked
      // about the milliseconds after it, it answers no.
      expect(await predatesInvalidation(store, ["gate-before"], start)).toBe(
        false,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks the store about another isolate's invalidation after the start's millisecond", async () => {
    const isTagsInvalidatedSince = vi.fn(async () => true);
    const store = { isTagsInvalidatedSince } as unknown as SegmentCacheStore;
    const start = executionStart();

    expect(await predatesInvalidation(store, ["gate-remote"], start)).toBe(
      true,
    );
    expect(isTagsInvalidatedSince).toHaveBeenCalledWith(
      ["gate-remote"],
      start.at + 1,
      { failClosed: true },
    );
    expect(await predatesInvalidation(store, [], start)).toBe(false);
    expect(isTagsInvalidatedSince).toHaveBeenCalledTimes(1);
  });

  it("a second evaluated copy of the module reads the invalidations the first recorded", async () => {
    const store = new MemorySegmentCacheStore();
    vi.resetModules();
    const copy = await import("../tag-invalidation.js");
    const start = copy.executionStart();
    await invalidateIn(store, "gate-module-copy");

    expect(copy.invalidatedSince(["gate-module-copy"], start.seq)).toBe(true);
  });

  it("stays bounded: an execution older than a forgotten invalidation counts as invalidated", async () => {
    const store = new MemorySegmentCacheStore();
    const before = executionStart();
    await runWithRequestContext(withStore(store), async () => {
      for (let i = 0; i <= 1024; i++) await updateTag(`gate-bulk-${i}`);
    });
    const after = executionStart();

    // gate-bulk-0 was dropped from the history: any tag of an execution that
    // started before it may have been invalidated.
    expect(invalidatedSince(["gate-never-invalidated"], before.seq)).toBe(true);
    expect(invalidatedSince(["gate-never-invalidated"], after.seq)).toBe(false);
    expect(invalidatedSince([], before.seq)).toBe(false);
  });
});

describe("outside a request context", () => {
  beforeEach(() => {
    MemorySegmentCacheStore.resetGlobalCache();
  });

  // No runWithRequestContext wrapper: _getRequestContext() returns undefined,
  // mirroring a Cloudflare queue consumer or scheduled job. The warning must name
  // the missing context, not point at store configuration.

  it("updateTag warns about the missing context (not store config) and does not throw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(updateTag("products")).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Called outside a request context"),
    );
    // It must NOT misdirect the consumer to store configuration.
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("No tag-capable cache store"),
    );
    warn.mockRestore();
  });

  it("revalidateTag warns about the missing context (not store config) and does not throw", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => revalidateTag("products")).not.toThrow();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Called outside a request context"),
    );
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("No tag-capable cache store"),
    );
    warn.mockRestore();
  });

  it("still warns about store config (not context) when a context exists but has no tag-capable store", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = makeCtx({}); // a real request context, but no stores

    await runWithRequestContext(ctx, async () => {
      await updateTag("products");
    });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("No tag-capable cache store"),
    );
    // The has-context case must not emit the missing-context warning.
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("Called outside a request context"),
    );
    warn.mockRestore();
  });
});

// Issue #941: the isolate memos (shell, tag markers) can predate a mutation
// made on another isolate. The response of a request that ran updateTag() or
// revalidateTag() sets the fresh-reads cookie for as long as the stores'
// memos can stay stale, and the same user's requests carrying it read past
// them (isolate-tag-memo.ts).
describe("the fresh-reads cookie", () => {
  function storeWithWindow(freshReadsWindowMs?: number): SegmentCacheStore {
    const store = new MemorySegmentCacheStore();
    if (freshReadsWindowMs !== undefined) {
      Object.defineProperty(store, "freshReadsWindowMs", {
        value: freshReadsWindowMs,
      });
    }
    return store;
  }

  function ctxFor(cacheStore: SegmentCacheStore, cookie?: string) {
    const request = new Request("https://example.com/", {
      headers: cookie ? { cookie } : {},
    });
    return createRequestContext({
      env: {},
      request,
      url: new URL(request.url),
      variables: {},
      cacheStore,
      stateCookieName: "rango-state_router_0",
    });
  }

  it("updateTag sets it for the stores' longest memo window, HttpOnly, SameSite=Lax, Path=/", async () => {
    const ctx = ctxFor(storeWithWindow(10_000));
    await runWithRequestContext(ctx, () => updateTag("products"));
    // Named by the state cookie prefix, so every router on the host that
    // shares it (and often shares the store) honors it.
    expect(ctx.res.headers.getSetCookie()).toContain(
      "rango-state-fresh=1; Max-Age=10; Path=/; HttpOnly; SameSite=Lax; Secure",
    );
  });

  it("revalidateTag sets it too, once per response, at the longest window", async () => {
    const ctx = ctxFor(storeWithWindow(2_500));
    await runWithRequestContext(ctx, async () => {
      revalidateTag("a");
      revalidateTag("b");
    });
    const fresh = ctx.res.headers
      .getSetCookie()
      .filter((cookie) => cookie.startsWith("rango-state-fresh="));
    expect(fresh).toEqual([
      "rango-state-fresh=1; Max-Age=3; Path=/; HttpOnly; SameSite=Lax; Secure",
    ]);
  });

  it("is not set when no store keeps an isolate memo", async () => {
    const ctx = ctxFor(storeWithWindow());
    await runWithRequestContext(ctx, () => updateTag("products"));
    expect(
      ctx.res.headers
        .getSetCookie()
        .some((cookie) => cookie.includes("-fresh=")),
    ).toBe(false);
  });

  it("a request carrying it is marked for fresh reads; one without it is not", () => {
    expect(ctxFor(storeWithWindow(), "rango-state-fresh=1")._freshReads).toBe(
      true,
    );
    expect(ctxFor(storeWithWindow(), "other=1")._freshReads).toBe(false);
  });

  // An action sets the cookie, then a streaming loader invalidates again after
  // the handoff: the cookie is already on the response for at least as long,
  // so nothing is lost and nothing to warn about.
  it("after the handoff, an invalidation the cookie already covers does not warn", async () => {
    const store = storeWithWindow(10_000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ctx = ctxFor(store);
      await runWithRequestContext(ctx, async () => {
        await updateTag("products");
        ctx._responseSent = true;
        await updateTag("products");
      });
      expect(
        ctx.res.headers
          .getSetCookie()
          .filter((cookie) => cookie.startsWith("rango-state-fresh=")),
      ).toEqual([
        "rango-state-fresh=1; Max-Age=10; Path=/; HttpOnly; SameSite=Lax; Secure",
      ]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  // Headers are handed to the host before a streaming loader or render ends;
  // a Set-Cookie written after that is lost. The invalidation still runs.
  it("after the response was handed off: no cookie, a dev warning, the invalidation still runs", async () => {
    const store = storeWithWindow(10_000);
    const invalidate = vi.spyOn(store, "invalidateTags");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ctx = ctxFor(store);
      ctx._responseSent = true;
      await runWithRequestContext(ctx, () => updateTag("products"));
      expect(invalidate).toHaveBeenCalledWith(["products"]);
      expect(
        ctx.res.headers
          .getSetCookie()
          .some((cookie) => cookie.includes("-fresh=")),
      ).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("after the response headers were sent"),
      );
    } finally {
      warn.mockRestore();
    }
  });
});
