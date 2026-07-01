import { describe, it, expect, vi } from "vitest";
import { createFindMatch } from "../find-match.js";
import { buildRouteTrie } from "../../build/route-trie.js";
import { setRouterTrie } from "../../route-map-builder.js";
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
