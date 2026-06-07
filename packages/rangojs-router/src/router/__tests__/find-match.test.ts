import { describe, it, expect, vi } from "vitest";
import { createFindMatch } from "../find-match.js";
import type { RouteEntry } from "../../types.js";

// No router trie is registered for these routerIds, so createFindMatch skips
// Phase 1 (trie) and exercises Phase 2 (regex fallback) directly — the path
// where the single-entry cache, the lazy-eval retry loop, and the cap live.

function nonLazyEntry(routes: Record<string, string>): RouteEntry {
  return {
    prefix: "",
    staticPrefix: "",
    routes,
  } as unknown as RouteEntry;
}

describe("createFindMatch", () => {
  it("resolves a route via the Phase-2 fallback when no trie is registered", () => {
    const fm = createFindMatch({
      routesEntries: [nonLazyEntry({ "user.show": "/users/:id" })],
      evaluateLazyEntry: () => {},
      routerId: "find-match-test-basic",
    });
    const r = fm("/users/5");
    expect(r?.routeKey).toBe("user.show");
    expect(r?.params).toEqual({ id: "5" });
  });

  // Regression (C7): the single-entry cache is module-lifetime and shared across
  // same-pathname requests. ctx.params aliases the result's params, so a caller
  // mutating params must NOT corrupt the cached entry for the next request.
  it("returns an independent params object on a cache hit (no cross-request bleed)", () => {
    const fm = createFindMatch({
      routesEntries: [nonLazyEntry({ "user.show": "/users/:id" })],
      evaluateLazyEntry: () => {},
      routerId: "find-match-test-clone",
    });

    const first = fm("/users/5");
    expect(first?.params).toEqual({ id: "5" });

    // Simulate a handler mutating ctx.params (which aliases result.params).
    first!.params.id = "MUTATED";
    (first!.params as Record<string, string>).injected = "x";

    // Same pathname → cache hit. Must be a clean clone, not the corrupted object.
    const second = fm("/users/5");
    expect(second?.params).toEqual({ id: "5" });
    expect(second?.params).not.toBe(first?.params);
  });

  it("recomputes for a different pathname after caching", () => {
    const fm = createFindMatch({
      routesEntries: [
        nonLazyEntry({ "user.show": "/users/:id", about: "/about" }),
      ],
      evaluateLazyEntry: () => {},
      routerId: "find-match-test-recompute",
    });
    expect(fm("/users/7")?.routeKey).toBe("user.show");
    expect(fm("/about")?.routeKey).toBe("about");
    expect(fm("/users/9")?.params).toEqual({ id: "9" });
  });

  // Regression: a lazy entry whose evaluateLazyEntry never marks it evaluated
  // would loop forever; the cap must bound it and return null (404) rather than
  // hang. Identical outcome in dev and production.
  it("caps runaway lazy evaluation and returns null", () => {
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
      expect(fm("/api/anything")).toBeNull();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("lazy evaluation iterations"),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
