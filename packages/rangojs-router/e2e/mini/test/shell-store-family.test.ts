import { describe, expect, it } from "vitest";
import React from "react";
import { MemorySegmentCacheStore } from "@rangojs/router/cache";
import type { ShellCacheEntry } from "@rangojs/router/cache";

// Userland dogfood of the PPR shell STORE family through the PUBLIC
// @rangojs/router/cache surface. PPR serving/capture is integral to the router
// (opt-in via the `ppr` path option — see src/router.tsx /manifest); the piece a
// consumer touches directly is the store family a custom SegmentCacheStore must
// implement (getShell/putShell), pinned here against the shipped memory store.
// The full live MISS -> capture -> HIT round-trip is the cloudflare-basic and
// test-app e2e suites' job (dev + production).

function entry(overrides: Partial<ShellCacheEntry> = {}): ShellCacheEntry {
  return {
    prelude: btoa("<html><body>SHELL</body></html>"),
    postponed: JSON.stringify({ hole: 1 }),
    reactVersion: React.version,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("shell store family (mini dogfood, public surface)", () => {
  it("round-trips a shell entry with ttl/swr semantics", async () => {
    const store = new MemorySegmentCacheStore({ defaults: { ttl: 60 } });
    await store.putShell("host/page:shell", entry(), 300, 60);
    const hit = await store.getShell("host/page:shell");
    expect(hit).not.toBeNull();
    expect(hit!.entry.postponed).toBe(JSON.stringify({ hole: 1 }));
    expect(hit!.shouldRevalidate).toBe(false);
    expect(await store.getShell("host/other:shell")).toBeNull();
  });

  it("participates in tag invalidation alongside the other families", async () => {
    const store = new MemorySegmentCacheStore();
    await store.putShell("host/tagged:shell", entry(), 300, 60, ["banner"]);
    await store.setItem("banner-item", "v1", { ttl: 300, tags: ["banner"] });
    await store.invalidateTags(["banner"]);
    expect(await store.getShell("host/tagged:shell")).toBeNull();
    expect(await store.getItem("banner-item")).toBeNull();
  });
});
