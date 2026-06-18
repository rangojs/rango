import { describe, expect, it, vi } from "vitest";

// Spy on safeDecodeURIComponent so we can count how many times trie-matching
// decodes a constraint route's param values. The bug (D4): a constraint-bearing
// leaf was decoded once during the walk (leafConstraintsPass) AND again in
// validateAndBuild — two full decode passes per request. The fix carries the
// walk-time validated params forward so validateAndBuild reuses them. Assert the
// decode happens once per param value, not twice.
const decodeSpy = vi.fn((raw: string) => decodeURIComponent(raw));
vi.mock("../url-params.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../url-params.js")>();
  return {
    ...actual,
    safeDecodeURIComponent: (raw: string) => decodeSpy(raw),
  };
});

const { buildRouteTrie } = await import("../../build/route-trie");
const { tryTrieMatch } = await import("../trie-matching");

function buildTestTrie(routes: Record<string, string>) {
  const ancestry: Record<string, string[]> = {};
  const staticPrefix: Record<string, string> = {};
  for (const [routeKey, pattern] of Object.entries(routes)) {
    ancestry[routeKey] = [`A:${routeKey}`];
    const dynamicIdx = pattern.search(/[:*]/);
    if (dynamicIdx === -1) {
      staticPrefix[routeKey] = pattern === "/" ? "" : pattern;
      continue;
    }
    const prefix = pattern.slice(0, dynamicIdx);
    staticPrefix[routeKey] = prefix.endsWith("/")
      ? prefix.slice(0, -1)
      : prefix;
  }
  return buildRouteTrie(routes, ancestry, staticPrefix);
}

describe("trie matching — constraint route decode (D4)", () => {
  it("decodes a matched constraint route's param value exactly once", () => {
    const trie = buildTestTrie({
      "docs.lang": "/docs/:lang(en|gb)",
    });

    decodeSpy.mockClear();
    const result = tryTrieMatch(trie, "/docs/en");

    expect(result?.routeKey).toBe("docs.lang");
    expect(result?.params).toEqual({ lang: "en" });
    // One decode for the single param value. Before the fix this was 2 (walk +
    // validateAndBuild re-decode).
    expect(decodeSpy).toHaveBeenCalledTimes(1);
    expect(decodeSpy).toHaveBeenCalledWith("en");
  });

  it("decodes each constraint param value once on a multi-param route", () => {
    const trie = buildTestTrie({
      "shop.cat": "/shop/:cat(food|drink)/:size(s|m|l)",
    });

    decodeSpy.mockClear();
    const result = tryTrieMatch(trie, "/shop/food/m");

    expect(result?.params).toEqual({ cat: "food", size: "m" });
    // Two param values, decoded once each (not 4).
    expect(decodeSpy).toHaveBeenCalledTimes(2);
  });
});
