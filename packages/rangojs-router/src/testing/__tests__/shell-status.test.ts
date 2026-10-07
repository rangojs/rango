import { describe, expect, it } from "vitest";
import React from "react";
import { MemorySegmentCacheStore } from "../../cache/memory-segment-store.js";
import { compileSearchParamsFilter } from "../../cache/search-params-filter.js";
import type { ShellCacheEntry } from "../../cache/types.js";
import { buildShellKey, partitionShellKey } from "../../rsc/shell-serve.js";
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
    snapshot: [],
    ...overrides,
  };
}

/** The router the keys below belong to: anything carrying a router's id. */
const ROUTER = { id: "shop" };

describe("shellCacheKey (production key identity)", () => {
  // #1065: a shell belongs to one router. Keyed by host and path alone, two
  // routers serving one host and path (a hostOverride cookie, a warm under
  // another router's host) read and overwrote each other's shell.
  it("carries the router's id: two routers on one URL have two keys", () => {
    const url = "http://shop.test/p";
    expect(shellCacheKey(ROUTER, url)).toBe("shop@shop.test/p:shell");
    expect(shellCacheKey({ id: "preview" }, url)).toBe(
      "preview@shop.test/p:shell",
    );
    expect(shellCacheKey({ id: "a/b@c" }, url)).toBe(
      "a%2Fb%40c@shop.test/p:shell",
    );
  });

  it("appends a key() result's partition exactly as the serve path does: namespaced (#975)", () => {
    const url = new URL("http://shop.test/p?b=2&a=1");
    expect(shellCacheKey(ROUTER, url, undefined, "tier:gold")).toBe(
      partitionShellKey(buildShellKey(ROUTER.id, url), "key:tier%3Agold"),
    );
    expect(shellCacheKey(ROUTER, url, undefined, "tier:gold")).not.toBe(
      shellCacheKey(ROUTER, url, undefined, "tier:silver"),
    );
  });

  it("encodes the partition, so no partition can end in another key's suffix", () => {
    const url = new URL("http://shop.test/p");
    const key = shellCacheKey(ROUTER, url, undefined, "tier:gold:navigation");
    expect(key).toBe(
      "shop@shop.test/p:shell|key%3Atier%253Agold%253Anavigation",
    );
    expect(key).not.toBe(
      `${shellCacheKey(ROUTER, url, undefined, "tier:gold")}:navigation`,
    );
    expect(shellCacheKey(ROUTER, url, undefined, "a|b")).toBe(
      "shop@shop.test/p:shell|key%3Aa%257Cb",
    );
  });

  it("composes nested cache() key() results, outermost first, as the record key does (#970)", () => {
    const url = new URL("http://shop.test/p");
    expect(shellCacheKey(ROUTER, url, undefined, ["tier:gold", "v:a"])).toBe(
      partitionShellKey(
        buildShellKey(ROUTER.id, url),
        "key:tier%3Agold|key:v%3Aa",
      ),
    );
    // One key() result is the plain partition.
    expect(shellCacheKey(ROUTER, url, undefined, ["tier:gold"])).toBe(
      shellCacheKey(ROUTER, url, undefined, "tier:gold"),
    );
    expect(shellCacheKey(ROUTER, url, undefined, ["a|b", "c"])).not.toBe(
      shellCacheKey(ROUTER, url, undefined, ["a", "b|c"]),
    );
  });

  it("takes store keyGenerator results as `generated`: a lone one raw, with key() results encoded after them", () => {
    const url = new URL("http://shop.test/p");
    const generated = "doc:shop.test/p|de";
    expect(
      shellCacheKey(ROUTER, url, undefined, { generated: [generated] }),
    ).toBe(partitionShellKey(buildShellKey(ROUTER.id, url), generated));
    expect(
      shellCacheKey(ROUTER, url, undefined, {
        keys: ["tier:gold"],
        generated: [generated],
      }),
    ).toBe(
      partitionShellKey(
        buildShellKey(ROUTER.id, url),
        "key:tier%3Agold|doc%3Ashop.test%2Fp%7Cde",
      ),
    );
    expect(shellCacheKey(ROUTER, url, undefined, { keys: ["tier:gold"] })).toBe(
      shellCacheKey(ROUTER, url, undefined, "tier:gold"),
    );
    // A store whose result is the default key keeps its position as "".
    expect(
      shellCacheKey(ROUTER, url, undefined, { generated: ["", generated] }),
    ).toBe(
      partitionShellKey(
        buildShellKey(ROUTER.id, url),
        "|doc%3Ashop.test%2Fp%7Cde",
      ),
    );
  });

  it("no key() or keyGenerator result is no partition", () => {
    const url = new URL("http://shop.test/p");
    expect(shellCacheKey(ROUTER, url, undefined, [])).toBe(
      buildShellKey(ROUTER.id, url),
    );
    expect(shellCacheKey(ROUTER, url, undefined, {})).toBe(
      buildShellKey(ROUTER.id, url),
    );
  });

  it("matches rsc/shell-serve buildShellKey for host+path+search", () => {
    const cases = [
      "http://localhost/products/1",
      "https://shop.example.com/products/1?b=2&a=1",
      "http://localhost/path?_rsc=1&page=2",
      "http://tenant-a.example.com/",
    ];
    for (const href of cases) {
      const url = new URL(href);
      expect(shellCacheKey(ROUTER, url)).toBe(buildShellKey(ROUTER.id, url));
      expect(shellCacheKey(ROUTER, href)).toBe(buildShellKey(ROUTER.id, url));
    }
  });

  it("strips reserved router search params from the key (same as production)", () => {
    const withRsc = new URL("http://localhost/p?page=1&_rsc_partial=1");
    const bare = new URL("http://localhost/p?page=1");
    expect(shellCacheKey(ROUTER, withRsc)).toBe(shellCacheKey(ROUTER, bare));
    expect(shellCacheKey(ROUTER, withRsc)).toBe(
      buildShellKey(ROUTER.id, withRsc),
    );
  });

  it("applies cache.searchParams the same way production buildShellKey does", () => {
    const searchParams = { exclude: ["utm_*", "fbclid"] } as const;
    const filter = compileSearchParamsFilter(searchParams);
    const tracked = new URL("http://localhost/p?utm_source=tw&fbclid=1&q=x");
    const bare = new URL("http://localhost/p?q=x");
    expect(shellCacheKey(ROUTER, tracked, searchParams)).toBe(
      buildShellKey(ROUTER.id, tracked, filter),
    );
    expect(shellCacheKey(ROUTER, tracked, searchParams)).toBe(
      shellCacheKey(ROUTER, bare),
    );
    // Without the config, tracked params stay in the key.
    expect(shellCacheKey(ROUTER, tracked)).not.toBe(
      shellCacheKey(ROUTER, bare),
    );
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

  it.each([
    ["HIT; freshness=fresh", { outcome: "HIT", freshness: "fresh" } as const],
    ["HIT; freshness=stale", { outcome: "HIT", freshness: "stale" } as const],
    [
      "BYPASS; reason=no-entry",
      { outcome: "BYPASS", reason: "no-entry" } as const,
    ],
    [
      "BYPASS; reason=no-segment-snapshot",
      { outcome: "BYPASS", reason: "no-segment-snapshot" } as const,
    ],
  ])("parses and asserts %s", (raw, expected) => {
    const response = responseWith(raw);
    expect(parsePprReplayStatus(response)).toEqual(expected);
    expect(() => assertPprReplayStatus(response, expected)).not.toThrow();
  });

  it.each([
    null,
    "HIT",
    "HIT; freshness=expired",
    "BYPASS; reason=unbounded-detail",
    "BYPASS; reason=no-entry; extra=true",
    // Removed with the handler-live fast-path decline: a HIT never runs
    // handlers, so no entry is ineligible for these reasons.
    "BYPASS; reason=handler-live-holes",
    "BYPASS; reason=transition-when",
  ])("rejects absent or malformed value %s", (raw) => {
    expect(parsePprReplayStatus(responseWith(raw))).toBeNull();
  });

  it("throws for missing, malformed, and mismatched statuses", () => {
    expect(() =>
      assertPprReplayStatus(responseWith(null), {
        outcome: "HIT",
        freshness: "fresh",
      }),
    ).toThrow(/no x-rango-ppr-replay/);
    expect(() =>
      assertPprReplayStatus(responseWith("BYPASS; reason=unknown"), {
        outcome: "BYPASS",
        reason: "no-entry",
      }),
    ).toThrow(/unrecognized/);
    expect(() =>
      assertPprReplayStatus(responseWith("HIT; freshness=stale"), {
        outcome: "HIT",
        freshness: "fresh",
      }),
    ).toThrow(/expected .*fresh.* got .*stale/);
  });
});

describe("MemorySegmentCacheStore + shellCacheKey (public store dogfood)", () => {
  // A live MISS→capture→HIT runs through serveShellRequest
  // (serve-shell-request.rsc-test.tsx). This covers the store half: production
  // key identity + real getShell/putShell on MemorySegmentCacheStore — no
  // faked HIT Response.
  it("stores and retrieves a shell under the production key after putShell", async () => {
    const store = new MemorySegmentCacheStore();
    const url = new URL("http://localhost/products/42?utm=x&sort=price");
    const key = shellCacheKey(ROUTER, url);

    expect(await store.getShell(key)).toBeNull();

    await store.putShell(key, entry(), 300, 60, ["product"]);
    const hit = await store.getShell(key);
    expect(hit).not.toBeNull();
    expect(hit!.entry.buildVersion).toBe("test-build");
    expect(hit!.shouldRevalidate).toBe(false);

    // A different host must not collide (multi-tenant key contract).
    expect(
      await store.getShell(
        shellCacheKey(
          ROUTER,
          "https://other.example.com/products/42?sort=price",
        ),
      ),
    ).toBeNull();

    await store.invalidateTags(["product"]);
    expect(await store.getShell(key)).toBeNull();
  });
});
