import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { MemorySegmentCacheStore } from "../../cache/memory-segment-store.js";
import type { ShellCacheEntry } from "../../cache/types.js";
import {
  lookupBuildShell,
  resetBuildShellManifestForTests,
  type BuildShellEntry,
} from "../shell-build-manifest.js";

const BUILD_VERSION = "build-1";

function entry(overrides: Partial<ShellCacheEntry> = {}): ShellCacheEntry {
  return {
    prelude: btoa("<html><body>SHELL</body></html>"),
    postponed: JSON.stringify({ hole: 1 }),
    reactVersion: React.version,
    buildVersion: BUILD_VERSION,
    createdAt: Date.now(),
    ...overrides,
  };
}

/** Install a fake production shell manifest for one pathname. */
function installManifest(records: Record<string, BuildShellEntry>): void {
  (globalThis as any).__loadShellManifestModule = async () => ({
    default: Object.fromEntries(Object.keys(records).map((k) => [k, k])),
    loadShellAsset: async (spec: string) => ({ default: records[spec]! }),
  });
}

describe("lookupBuildShell (build-shell read-through gates)", () => {
  let store: MemorySegmentCacheStore;

  beforeEach(() => {
    MemorySegmentCacheStore.resetGlobalCache();
    store = new MemorySegmentCacheStore();
    resetBuildShellManifestForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    delete (globalThis as any).__loadShellManifestModule;
    resetBuildShellManifestForTests();
    vi.useRealTimers();
  });

  const url = (p: string) => new URL(p, "http://app.test");

  it("serves a fresh manifest entry (stale=false inside ttl)", async () => {
    installManifest({ "/pp/a": { entry: entry(), ttl: 300, routeName: "pp" } });
    const hit = await lookupBuildShell(url("/pp/a"), BUILD_VERSION, store);
    expect(hit).not.toBeNull();
    expect(hit!.stale).toBe(false);
  });

  it("marks the entry stale past createdAt + ttl (serve + recapture upgrade)", async () => {
    installManifest({ "/pp/a": { entry: entry(), ttl: 300, routeName: "pp" } });
    vi.setSystemTime(Date.now() + 301_000);
    const hit = await lookupBuildShell(url("/pp/a"), BUILD_VERSION, store);
    expect(hit).not.toBeNull();
    expect(hit!.stale).toBe(true);
  });

  it("skips search-bearing URLs (runtime capture owns those shell keys)", async () => {
    installManifest({ "/pp/a": { entry: entry(), ttl: 300, routeName: "pp" } });
    expect(
      await lookupBuildShell(url("/pp/a?x=1"), BUILD_VERSION, store),
    ).toBeNull();
  });

  it("misses unknown pathnames", async () => {
    installManifest({ "/pp/a": { entry: entry(), ttl: 300, routeName: "pp" } });
    expect(
      await lookupBuildShell(url("/pp/b"), BUILD_VERSION, store),
    ).toBeNull();
  });

  it("rejects a buildVersion mismatch (stale deploy artifact)", async () => {
    installManifest({
      "/pp/a": {
        entry: entry({ buildVersion: "older-build" }),
        ttl: 300,
        routeName: "pp",
      },
    });
    expect(
      await lookupBuildShell(url("/pp/a"), BUILD_VERSION, store),
    ).toBeNull();
  });

  it("rejects a corrupt prelude (integrity gate before commit)", async () => {
    installManifest({
      "/pp/a": {
        entry: entry({ prelude: "not-base64!!!" }),
        ttl: 300,
        routeName: "pp",
      },
    });
    expect(
      await lookupBuildShell(url("/pp/a"), BUILD_VERSION, store),
    ).toBeNull();
  });

  it("tag markers evict: invalidated at/after createdAt rejects, before serves", async () => {
    installManifest({
      "/pp/a": {
        entry: entry(),
        ttl: 300,
        tags: ["pp-shell"],
        routeName: "pp",
      },
    });
    // Not invalidated: serves.
    expect(
      await lookupBuildShell(url("/pp/a"), BUILD_VERSION, store),
    ).not.toBeNull();
    // Invalidate NOW (>= createdAt): rejected — updateTag reaches the
    // immutable manifest entry through the marker comparison.
    await store.invalidateTags(["pp-shell"]);
    expect(
      await lookupBuildShell(url("/pp/a"), BUILD_VERSION, store),
    ).toBeNull();
  });

  it("declines TAGGED entries on a store without isTagsInvalidatedSince (updateTag could never evict them)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      installManifest({
        "/pp/tagless-store": {
          entry: entry(),
          ttl: 300,
          tags: ["t"],
          routeName: "pp",
        },
        "/pp/untagged": { entry: entry(), ttl: 300, routeName: "pp" },
      });
      const bareStore = {} as any;
      expect(
        await lookupBuildShell(
          url("/pp/tagless-store"),
          BUILD_VERSION,
          bareStore,
        ),
      ).toBeNull();
      // An UNTAGGED entry needs no marker support and still serves.
      expect(
        await lookupBuildShell(url("/pp/untagged"), BUILD_VERSION, bareStore),
      ).not.toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it("is inert with no manifest loader and no dev context", async () => {
    expect(
      await lookupBuildShell(url("/pp/a"), BUILD_VERSION, store),
    ).toBeNull();
  });

  describe("dev on-demand branch", () => {
    const DEV_RECORD: BuildShellEntry = {
      entry: entry(),
      ttl: 300,
      routeName: "pp",
    };

    beforeEach(() => {
      (globalThis as any).__PRERENDER_DEV_URL = "http://dev.test";
    });

    afterEach(() => {
      delete (globalThis as any).__PRERENDER_DEV_URL;
      vi.unstubAllGlobals();
    });

    it("fetches /__rsc_shell for prerendered routes and applies the serve gates", async () => {
      const fetchMock = vi.fn(
        async (_input: string, _init?: RequestInit) =>
          new Response(JSON.stringify(DEV_RECORD), { status: 200 }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const hit = await lookupBuildShell(url("/pp/a"), BUILD_VERSION, store, {
        isPrerenderRoute: true,
        routeName: "pp",
        ttl: 300,
      });
      expect(hit).not.toBeNull();
      const fetched = new URL(fetchMock.mock.calls[0]![0]);
      expect(fetched.pathname).toBe("/__rsc_shell");
      expect(fetched.searchParams.get("pathname")).toBe("/pp/a");
      expect(fetched.searchParams.get("routeName")).toBe("pp");
      expect(fetched.searchParams.get("version")).toBe(BUILD_VERSION);
    });

    it("never fetches for non-prerendered routes (producer A owns them)", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      expect(
        await lookupBuildShell(url("/live"), BUILD_VERSION, store, {
          isPrerenderRoute: false,
          routeName: "live",
          ttl: 300,
        }),
      ).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("degrades a failing endpoint to a MISS", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("nope", { status: 404 })),
      );
      expect(
        await lookupBuildShell(url("/pp/a"), BUILD_VERSION, store, {
          isPrerenderRoute: true,
          routeName: "pp",
          ttl: 300,
        }),
      ).toBeNull();
    });

    // Boot-race readiness (issue #719): a Prerender+ppr route's FIRST request
    // can beat the endpoint standing up its capture realm (temp server /
    // registry import / Vite dep re-optimization). The endpoint marks those
    // TRANSIENT states 503 + x-rango-shell-dev: NOT-READY; the read-through
    // must re-poll ONLY that signal so the first request still HITs, rather
    // than mapping the boot window to a hard MISS that heals on a later poll.
    it("re-polls a NOT-READY boot-race signal, then serves once ready (first-request HIT holds)", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response("booting", {
            status: 503,
            headers: { "x-rango-shell-dev": "NOT-READY" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(DEV_RECORD), { status: 200 }),
        );
      vi.stubGlobal("fetch", fetchMock);
      const p = lookupBuildShell(url("/pp/a"), BUILD_VERSION, store, {
        isPrerenderRoute: true,
        routeName: "pp",
        ttl: 300,
      });
      // Fire the ~150ms readiness re-poll delay (fake timers).
      await vi.advanceTimersByTimeAsync(200);
      const hit = await p;
      expect(hit).not.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does NOT re-poll a genuine 404 negative (a non-baked route never stalls the foreground)", async () => {
      const fetchMock = vi.fn(
        async () => new Response("nope", { status: 404 }),
      );
      vi.stubGlobal("fetch", fetchMock);
      expect(
        await lookupBuildShell(url("/pp/a"), BUILD_VERSION, store, {
          isPrerenderRoute: true,
          routeName: "pp",
          ttl: 300,
        }),
      ).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // Issue #719 P2: only 503 + NOT-READY (a transient re-optimization) is
    // re-pollable. A terminal boot failure — a broken temp server or a faulted
    // registry import — fails fast with a PLAIN 503 (no NOT-READY header). The
    // read-through must MISS on the first attempt, never re-poll a permanently
    // broken realm for the full 10s readiness deadline.
    it("does NOT re-poll a plain 503 without the NOT-READY header (terminal boot failure MISSes fast)", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response("Shell capture runners not available", { status: 503 }),
      );
      vi.stubGlobal("fetch", fetchMock);
      expect(
        await lookupBuildShell(url("/pp/a"), BUILD_VERSION, store, {
          isPrerenderRoute: true,
          routeName: "pp",
          ttl: 300,
        }),
      ).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("concedes a MISS when NOT-READY never clears (readiness wait is bounded)", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response("booting", {
            status: 503,
            headers: { "x-rango-shell-dev": "NOT-READY" },
          }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const p = lookupBuildShell(url("/pp/a"), BUILD_VERSION, store, {
        isPrerenderRoute: true,
        routeName: "pp",
        ttl: 300,
      });
      // Advance past the readiness deadline: the bounded loop must exit, not spin.
      await vi.advanceTimersByTimeAsync(11_000);
      expect(await p).toBeNull();
      expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    });
  });
});
