import { describe, expect, it } from "vitest";
import React from "react";
import { MemorySegmentCacheStore } from "../../cache/memory-segment-store.js";
import type { ShellCacheEntry } from "../../cache/types.js";
import { buildShellKey } from "../../rsc/shell-serve.js";
import {
  assertPprReplayStatus,
  assertShellStatus,
  parsePprReplayStatus,
  parseShellStatus,
  PPR_REPLAY_STATUS_HEADER,
  shellCacheKey,
  SHELL_STATUS_HEADER,
} from "../shell-status.js";

function entry(overrides: Partial<ShellCacheEntry> = {}): ShellCacheEntry {
  return {
    prelude: btoa("<html><body>SHELL</body></html>"),
    postponed: JSON.stringify({ hole: 1 }),
    reactVersion: React.version,
    buildVersion: "test-build",
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("shellCacheKey (production key identity)", () => {
  it("matches rsc/shell-serve buildShellKey for host+path+search", () => {
    const cases = [
      "http://localhost/products/1",
      "https://shop.example.com/products/1?b=2&a=1",
      "http://localhost/path?_rsc=1&page=2",
      "http://tenant-a.example.com/",
    ];
    for (const href of cases) {
      const url = new URL(href);
      expect(shellCacheKey(url)).toBe(buildShellKey(url));
      expect(shellCacheKey(href)).toBe(buildShellKey(url));
    }
  });

  it("strips reserved router search params from the key (same as production)", () => {
    const withRsc = new URL("http://localhost/p?page=1&_rsc_partial=1");
    const bare = new URL("http://localhost/p?page=1");
    expect(shellCacheKey(withRsc)).toBe(shellCacheKey(bare));
    expect(shellCacheKey(withRsc)).toBe(buildShellKey(withRsc));
  });
});

describe("assertShellStatus / parseShellStatus", () => {
  function responseWith(status: string | null): Response {
    if (status === null) return new Response(null);
    return new Response(null, {
      headers: { [SHELL_STATUS_HEADER]: status },
    });
  }

  it("passes when the header matches", () => {
    expect(() => assertShellStatus(responseWith("HIT"), "HIT")).not.toThrow();
    expect(() => assertShellStatus(responseWith("MISS"), "MISS")).not.toThrow();
  });

  it("works against a plain { headers } target (Playwright wrap shape)", () => {
    const target = {
      headers: new Headers({ [SHELL_STATUS_HEADER]: "HIT" }),
    };
    expect(() => assertShellStatus(target, "HIT")).not.toThrow();
    expect(parseShellStatus(target)).toBe("HIT");
  });

  it("throws when the header is missing or mismatched", () => {
    expect(() => assertShellStatus(responseWith(null), "HIT")).toThrow(
      /no x-rango-shell/,
    );
    expect(() => assertShellStatus(responseWith("MISS"), "HIT")).toThrow(
      /expected "HIT" but got "MISS"/,
    );
  });

  it("parseShellStatus returns null for absent/unrecognized values", () => {
    expect(parseShellStatus(responseWith(null))).toBeNull();
    expect(parseShellStatus(responseWith("STALE"))).toBeNull();
    expect(parseShellStatus(responseWith("HIT"))).toBe("HIT");
  });
});

describe("assertPprReplayStatus / parsePprReplayStatus", () => {
  function responseWith(status: string | null): Response {
    if (status === null) return new Response(null);
    return new Response(null, {
      headers: { [PPR_REPLAY_STATUS_HEADER]: status },
    });
  }

  it("recognizes a confirmed partial-navigation replay HIT", () => {
    expect(() =>
      assertPprReplayStatus(responseWith("HIT"), "HIT"),
    ).not.toThrow();
    expect(parsePprReplayStatus(responseWith("HIT"))).toBe("HIT");
  });

  it("treats an absent or unrecognized signal as no replay", () => {
    expect(parsePprReplayStatus(responseWith(null))).toBeNull();
    expect(parsePprReplayStatus(responseWith("MISS"))).toBeNull();
    expect(() => assertPprReplayStatus(responseWith(null), "HIT")).toThrow(
      /no x-rango-ppr-replay/,
    );
  });
});

describe("MemorySegmentCacheStore + shellCacheKey (public store dogfood)", () => {
  // Live MISS→capture→HIT needs the RSC/SSR capture pipeline (e2e). Unit layer
  // dogfoods the consumer-touchable half: production key identity + real
  // getShell/putShell on MemorySegmentCacheStore — no faked HIT Response.
  it("stores and retrieves a shell under the production key after putShell", async () => {
    const store = new MemorySegmentCacheStore();
    const url = new URL("http://localhost/products/42?utm=x&sort=price");
    const key = shellCacheKey(url);

    expect(await store.getShell(key)).toBeNull();

    await store.putShell(key, entry(), 300, 60, ["product"]);
    const hit = await store.getShell(key);
    expect(hit).not.toBeNull();
    expect(hit!.entry.buildVersion).toBe("test-build");
    expect(hit!.shouldRevalidate).toBe(false);

    // A different host must not collide (multi-tenant key contract).
    expect(
      await store.getShell(
        shellCacheKey("https://other.example.com/products/42?sort=price"),
      ),
    ).toBeNull();

    await store.invalidateTags(["product"]);
    expect(await store.getShell(key)).toBeNull();
  });
});
