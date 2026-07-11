import { describe, expect, it } from "vitest";
import React from "react";
import { MemorySegmentCacheStore } from "@rangojs/router/cache";
import type { ShellCacheEntry } from "@rangojs/router/cache";
import {
  assertShellStatus,
  shellCacheKey,
  SHELL_STATUS_HEADER,
} from "@rangojs/router/testing";

// Userland dogfood of the PPR shell STORE family + shell-status helpers through
// the PUBLIC @rangojs/router/cache and @rangojs/router/testing surfaces.
// Live MISS -> background capture -> HIT (x-rango-shell) needs the RSC/SSR
// pipeline and stays e2e (test-app / cloudflare-basic, dev + production).
// Unit layer: production shell key identity + getShell/putShell + header assert.

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
  it("round-trips a shell entry under shellCacheKey with ttl/swr semantics", async () => {
    const store = new MemorySegmentCacheStore({ defaults: { ttl: 60 } });
    const key = shellCacheKey("http://localhost/page");
    await store.putShell(key, entry(), 300, 60);
    const hit = await store.getShell(key);
    expect(hit).not.toBeNull();
    expect(hit!.entry.postponed).toBe(JSON.stringify({ hole: 1 }));
    expect(hit!.shouldRevalidate).toBe(false);
    expect(
      await store.getShell(shellCacheKey("http://localhost/other")),
    ).toBeNull();
  });

  it("participates in tag invalidation alongside the other families", async () => {
    const store = new MemorySegmentCacheStore();
    const key = shellCacheKey("http://localhost/tagged");
    await store.putShell(key, entry(), 300, 60, ["banner"]);
    await store.setItem("banner-item", "v1", { ttl: 300, tags: ["banner"] });
    await store.invalidateTags(["banner"]);
    expect(await store.getShell(key)).toBeNull();
    expect(await store.getItem("banner-item")).toBeNull();
  });

  it("assertShellStatus reads x-rango-shell on a document-shaped Response", () => {
    // Characterizes the public helper consumers use in e2e after a real
    // document GET — do not invent HIT Responses to claim capture worked.
    const res = new Response("<html></html>", {
      headers: {
        "content-type": "text/html",
        [SHELL_STATUS_HEADER]: "MISS",
      },
    });
    expect(() => assertShellStatus(res, "MISS")).not.toThrow();
  });
});
