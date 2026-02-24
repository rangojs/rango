import { describe, expect, it } from "vitest";
import { buildRouteTrie } from "../../build/route-trie";
import { tryTrieMatch } from "../trie-matching";

function buildTestTrie(
  routes: Record<string, string>,
  trailingSlash?: Record<string, string>,
) {
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
    staticPrefix[routeKey] = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  }

  return buildRouteTrie(routes, ancestry, staticPrefix, trailingSlash);
}

describe("tryTrieMatch", () => {
  it("matches root path", () => {
    const trie = buildTestTrie({ home: "/" });
    const result = tryTrieMatch(trie, "/");
    expect(result?.routeKey).toBe("home");
    expect(result?.params).toEqual({});
  });

  it("prioritizes static routes over param routes", () => {
    const trie = buildTestTrie({
      "docs.static": "/docs/new",
      "docs.param": "/docs/:slug",
    });

    const result = tryTrieMatch(trie, "/docs/new");
    expect(result?.routeKey).toBe("docs.static");
    expect(result?.params).toEqual({});
  });

  it("supports optional params with empty-string fill", () => {
    const trie = buildTestTrie({
      "shop.locale": "/shop/:locale(en|gb)?",
    });

    expect(tryTrieMatch(trie, "/shop")?.params).toEqual({ locale: "" });
    expect(tryTrieMatch(trie, "/shop/en")?.params).toEqual({ locale: "en" });
    expect(tryTrieMatch(trie, "/shop/fr")).toBeNull();
  });

  it("captures wildcard remainder", () => {
    const trie = buildTestTrie({
      "files.any": "/files/*",
    });

    const result = tryTrieMatch(trie, "/files/docs/guides/intro");
    expect(result?.routeKey).toBe("files.any");
    expect(result?.params).toEqual({ "*": "docs/guides/intro" });
  });

  it("applies trailing slash redirects from trie metadata", () => {
    const trie = buildTestTrie(
      {
        "docs.index": "/docs",
      },
      { "docs.index": "always" },
    );

    const result = tryTrieMatch(trie, "/docs");
    expect(result?.routeKey).toBe("docs.index");
    expect(result?.redirectTo).toBe("/docs/");
  });

  it("returns null for unmatched paths", () => {
    const trie = buildTestTrie({
      about: "/about",
    });

    expect(tryTrieMatch(trie, "/missing")).toBeNull();
  });
});
