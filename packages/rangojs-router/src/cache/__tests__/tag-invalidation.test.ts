import { describe, it, expect, beforeEach, vi } from "vitest";
import { MemorySegmentCacheStore } from "../memory-segment-store.js";
import { updateTag, revalidateTag } from "../tag-invalidation.js";
import { resolveCacheStore } from "../cache-policy.js";
import type { SegmentCacheStore } from "../types.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../server/request-context.js";
import { runWithRequestTransaction } from "../../router/request-identity.js";
import {
  getDevelopmentDiagnosticHub,
  resetDevelopmentDiagnosticHub,
} from "../../router/diagnostics/hub.js";

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
    resetDevelopmentDiagnosticHub();
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
      set: async () => ({ outcome: "stored" as const }),
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
      async setItem() {
        return { outcome: "stored" as const };
      },
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
    resetDevelopmentDiagnosticHub();
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

  it("links scheduled and completed diagnostics across waitUntil", async () => {
    const app = new MemorySegmentCacheStore();
    await app.setItem("k", "v", { ttl: 60, tags: ["products"] });
    const ctx = makeCtx({ cacheStore: app });
    const pending: Promise<void>[] = [];
    ctx.waitUntil = (fn: () => Promise<void>) => {
      pending.push(Promise.resolve().then(fn));
    };

    await runWithRequestTransaction(
      ctx.request,
      "request",
      () =>
        runWithRequestContext(ctx, async () => {
          revalidateTag("products");
        }),
      { routerId: "app", diagnosticsEnabled: true },
    );
    await Promise.all(pending);

    const trace = getDevelopmentDiagnosticHub()!.listTraces()[0]!;
    expect(
      trace.events.map((event) => [event.type, event.data.outcome]),
    ).toEqual([
      ["cache.tags", "scheduled"],
      ["cache.tags", "completed"],
    ]);
    expect(trace.events[1]?.transactionId).toBe(trace.events[0]?.transactionId);
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
      set: async () => ({ outcome: "stored" as const }),
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
