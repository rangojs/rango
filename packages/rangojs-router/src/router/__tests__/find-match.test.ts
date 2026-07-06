import { describe, it, expect, vi } from "vitest";
import { createFindMatch } from "../find-match.js";
import { buildRouteTrie } from "../../build/route-trie.js";
import {
  clearAllRouterData,
  isRouterTrieAuthoritative,
  markRouterTrieAuthoritative,
  registerRouterManifestLoader,
  ensureRouterManifest,
  setRouterTrie,
} from "../../route-map-builder.js";
import type { RouteEntry } from "../../types.js";

// No router trie is registered for these routerIds, so createFindMatch skips
// Phase 1 (trie) and exercises Phase 2 (regex fallback) directly — the path
// where the single-entry cache, the lazy-eval retry loop, and the cap live.
//
// findMatch is async (a lazy include may be backed by an async `() => import()`
// provider); for these eager-route cases it resolves in the same microtask.

function nonLazyEntry(routes: Record<string, string>): RouteEntry {
  return {
    prefix: "",
    staticPrefix: "",
    routes,
  } as unknown as RouteEntry;
}

describe("createFindMatch", () => {
  it("resolves a route via the Phase-2 fallback when no trie is registered", async () => {
    const fm = createFindMatch({
      routesEntries: [nonLazyEntry({ "user.show": "/users/:id" })],
      evaluateLazyEntry: () => {},
      routerId: "find-match-test-basic",
    });
    const r = await fm("/users/5");
    expect(r?.routeKey).toBe("user.show");
    expect(r?.params).toEqual({ id: "5" });
  });

  // Regression (C7): the single-entry cache is module-lifetime and shared across
  // same-pathname requests. ctx.params aliases the result's params, so a caller
  // mutating params must NOT corrupt the cached entry for the next request.
  it("returns an independent params object on a cache hit (no cross-request bleed)", async () => {
    const fm = createFindMatch({
      routesEntries: [nonLazyEntry({ "user.show": "/users/:id" })],
      evaluateLazyEntry: () => {},
      routerId: "find-match-test-clone",
    });

    const first = await fm("/users/5");
    expect(first?.params).toEqual({ id: "5" });

    // Simulate a handler mutating ctx.params (which aliases result.params).
    first!.params.id = "MUTATED";
    (first!.params as Record<string, string>).injected = "x";

    // Same pathname → cache hit. Must be a clean clone, not the corrupted object.
    const second = await fm("/users/5");
    expect(second?.params).toEqual({ id: "5" });
    expect(second?.params).not.toBe(first?.params);
  });

  it("recomputes for a different pathname after caching", async () => {
    const fm = createFindMatch({
      routesEntries: [
        nonLazyEntry({ "user.show": "/users/:id", about: "/about" }),
      ],
      evaluateLazyEntry: () => {},
      routerId: "find-match-test-recompute",
    });
    expect((await fm("/users/7"))?.routeKey).toBe("user.show");
    expect((await fm("/about"))?.routeKey).toBe("about");
    expect((await fm("/users/9"))?.params).toEqual({ id: "9" });
  });

  // Regression (R3): the dev-only "regex fallback resolved while the trie was
  // present" warning must fire ONLY on a genuine trie gap — not when the trie
  // matched but its owning RouteEntry was not resolvable yet (the supported
  // first-request lazy-splicing flow). We force the entry-resolve to miss by
  // giving the entry a staticPrefix that differs from the trie leaf's sp, so
  // findMatch falls through to the regex fallback even though the trie matched.
  it("does NOT warn when the trie matched but the entry resolved via the fallback (lazy lag)", async () => {
    // Trie knows the route (sp "/foo"); the flat entry has sp "" so the
    // trie-side entry-resolve misses and we fall through to Phase 2.
    setRouterTrie(
      "find-match-r3-suppress",
      buildRouteTrie(
        { "foo.show": "/foo/:id" },
        { "foo.show": ["A:foo.show"] },
        { "foo.show": "/foo" },
      ),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fm = createFindMatch({
        routesEntries: [nonLazyEntry({ "foo.show": "/foo/:id" })],
        evaluateLazyEntry: () => {},
        routerId: "find-match-r3-suppress",
      });
      expect((await fm("/foo/5"))?.routeKey).toBe("foo.show");
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("DOES warn when the trie was present but did not match (genuine trie gap)", async () => {
    // Trie holds an unrelated route, so it returns no match for "/foo/5" while
    // the regex fallback resolves it — a real trie gap worth surfacing in dev.
    setRouterTrie(
      "find-match-r3-warn",
      buildRouteTrie(
        { "bar.index": "/bar" },
        { "bar.index": ["A:bar.index"] },
        { "bar.index": "/bar" },
      ),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fm = createFindMatch({
        routesEntries: [nonLazyEntry({ "foo.show": "/foo/:id" })],
        evaluateLazyEntry: () => {},
        routerId: "find-match-r3-warn",
      });
      expect((await fm("/foo/5"))?.routeKey).toBe("foo.show");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("regex fallback"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  // Regression: a lazy entry whose evaluateLazyEntry never marks it evaluated
  // would loop forever; the cap must bound it and return null (404) rather than
  // hang. Identical outcome in dev and production.
  it("caps runaway lazy evaluation and returns null", async () => {
    const lazyEntry = {
      prefix: "",
      staticPrefix: "/api",
      routes: {},
      lazy: true,
      lazyEvaluated: false,
    } as unknown as RouteEntry;

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const fm = createFindMatch({
        routesEntries: [lazyEntry],
        // Never marks the entry evaluated -> findRouteMatch keeps signalling
        // "lazy evaluation needed" until the iteration cap trips.
        evaluateLazyEntry: () => {},
        routerId: "find-match-test-cap",
      });
      expect(await fm("/api/anything")).toBeNull();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("lazy evaluation iterations"),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// #664: when a router's trie was deserialized from the complete build manifest
// it is AUTHORITATIVE — a trie miss is a real 404, so findMatch must skip the
// regex fallback scan (the only route-count-proportional path) and must not
// evaluate lazy includes for unmatched (bot-probe) traffic. Dev-rebuilt tries
// are deliberately NOT authoritative: the dev trie-gap warning depends on the
// fallback running on misses.
describe("createFindMatch — authoritative trie miss (#664)", () => {
  function lazyProbeEntry(): RouteEntry {
    // staticPrefix "" prefix-matches EVERY pathname, so the regex fallback
    // would always probe (and lazily evaluate) this entry on a miss.
    return {
      prefix: "",
      staticPrefix: "",
      routes: {},
      lazy: true,
      lazyEvaluated: false,
    } as unknown as RouteEntry;
  }

  function trieFor(routerId: string) {
    setRouterTrie(
      routerId,
      buildRouteTrie(
        { "bar.index": "/bar" },
        { "bar.index": ["A:bar.index"] },
        { "bar.index": "" },
      ),
    );
  }

  it("skips the fallback scan and lazy evaluation on an authoritative miss", async () => {
    const routerId = "find-match-auth-miss";
    trieFor(routerId);
    markRouterTrieAuthoritative(routerId);

    const evaluate = vi.fn(() => {
      // Fallback probing would call this; an authoritative miss must not.
    });
    const fm = createFindMatch({
      routesEntries: [lazyProbeEntry()],
      evaluateLazyEntry: evaluate,
      routerId,
    });

    expect(await fm("/definitely-not-a-route.php")).toBeNull();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("still runs the fallback scan on a miss when the trie is NOT authoritative", async () => {
    const routerId = "find-match-nonauth-miss";
    trieFor(routerId);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const evaluate = vi.fn(() => {});
      const fm = createFindMatch({
        routesEntries: [lazyProbeEntry()],
        evaluateLazyEntry: evaluate,
        routerId,
      });

      expect(await fm("/definitely-not-a-route.php")).toBeNull();
      // Non-authoritative miss keeps today's behavior: the fallback probes the
      // prefix-matching lazy entry (and the runaway cap eventually trips
      // because the stub never marks it evaluated).
      expect(evaluate).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("leaves trie hits (including trailing-slash redirects) untouched when authoritative", async () => {
    const routerId = "find-match-auth-hit";
    // trailingSlash mode "never" so "/bar/" is a HIT carrying redirectTo —
    // slash handling is trie-native, so the authoritative gate never sees it
    // as a miss.
    setRouterTrie(
      routerId,
      buildRouteTrie(
        { "bar.index": "/bar" },
        { "bar.index": ["A:bar.index"] },
        { "bar.index": "" },
        { "bar.index": "never" },
      ),
    );
    markRouterTrieAuthoritative(routerId);

    const fm = createFindMatch({
      routesEntries: [nonLazyEntry({ "bar.index": "/bar" })],
      evaluateLazyEntry: () => {},
      routerId,
    });

    const exact = await fm("/bar");
    expect(exact?.routeKey).toBe("bar.index");

    // Trailing-slash handling is trie-native (post-match redirectTo), so the
    // authoritative gate must not affect it: "/bar/" is a HIT with a redirect,
    // not a miss.
    const slash = await fm("/bar/");
    expect(slash?.routeKey).toBe("bar.index");
    expect(slash?.redirectTo).toBe("/bar");
  });

  it("clearAllRouterData resets authoritativeness (HMR safety)", async () => {
    const routerId = "find-match-auth-clear";
    markRouterTrieAuthoritative(routerId);
    expect(isRouterTrieAuthoritative(routerId)).toBe(true);
    clearAllRouterData();
    expect(isRouterTrieAuthoritative(routerId)).toBe(false);
  });

  it("ensureRouterManifest marks the router authoritative when the loaded module carries a trie", async () => {
    const routerId = "find-match-auth-loader";
    registerRouterManifestLoader(routerId, async () => ({
      manifest: { "bar.index": "/bar" },
      trie: buildRouteTrie(
        { "bar.index": "/bar" },
        { "bar.index": ["A:bar.index"] },
        { "bar.index": "" },
      ),
    }));
    await ensureRouterManifest(routerId);
    expect(isRouterTrieAuthoritative(routerId)).toBe(true);
  });
});

describe("createFindMatch — shared static-prefix async include candidate scan", () => {
  function sharedPrefixLazyEntry(routes: Record<string, string>): RouteEntry {
    return {
      prefix: "",
      staticPrefix: "/shop", // deliberately shared across candidates
      routes,
      lazy: true,
      lazyEvaluated: false,
    } as unknown as RouteEntry;
  }

  it("scans past a non-owner shared-prefix candidate to the owner (both evaluated)", async () => {
    const first = sharedPrefixLazyEntry({}); // no route key -> not the owner
    const second = sharedPrefixLazyEntry({ "shop.b": "/shop/b/:id" }); // owner
    const evaluated: string[] = [];

    setRouterTrie(
      "find-match-shared-happy",
      buildRouteTrie(
        { "shop.b": "/shop/b/:id" },
        { "shop.b": ["A:shop.b"] },
        { "shop.b": "/shop" },
      ),
    );

    const fm = createFindMatch({
      routesEntries: [first, second],
      evaluateLazyEntry: (e) => {
        evaluated.push(e === first ? "first" : "second");
        return Promise.resolve();
      },
      routerId: "find-match-shared-happy",
    });

    const r = await fm("/shop/b/5");
    expect(r?.routeKey).toBe("shop.b");
    expect(r?.params).toEqual({ id: "5" });
    expect(r?.entry).toBe(second);
    expect(evaluated).toEqual(["first", "second"]); // scanned both (cross-import)
  });

  it("isolates a failing shared-prefix provider and resolves via the sibling", async () => {
    const failing = sharedPrefixLazyEntry({}); // provider rejects
    const owner = sharedPrefixLazyEntry({ "shop.b": "/shop/b/:id" });

    setRouterTrie(
      "find-match-shared-isolate",
      buildRouteTrie(
        { "shop.b": "/shop/b/:id" },
        { "shop.b": ["A:shop.b"] },
        { "shop.b": "/shop" },
      ),
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const fm = createFindMatch({
        routesEntries: [failing, owner],
        evaluateLazyEntry: (e) =>
          e === failing
            ? Promise.reject(new Error("import failed"))
            : Promise.resolve(),
        routerId: "find-match-shared-isolate",
      });

      const r = await fm("/shop/b/9"); // must NOT throw
      expect(r?.routeKey).toBe("shop.b");
      expect(r?.entry).toBe(owner);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("failed to load"),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
