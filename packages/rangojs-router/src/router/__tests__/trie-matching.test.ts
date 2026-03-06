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
    staticPrefix[routeKey] = prefix.endsWith("/")
      ? prefix.slice(0, -1)
      : prefix;
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

  describe("malformed URL handling", () => {
    it("does not match path traversal segments", () => {
      const trie = buildTestTrie({
        secret: "/admin/secret",
        param: "/admin/:page",
      });

      expect(tryTrieMatch(trie, "/admin/../admin/secret")).toBeNull();
      expect(tryTrieMatch(trie, "/admin/..")).not.toBeNull();
      // ".." is treated as a literal segment value, not traversal
      expect(tryTrieMatch(trie, "/admin/..")?.params).toEqual({ page: ".." });
    });

    it("does not match double-slash paths against single-segment routes", () => {
      const trie = buildTestTrie({
        about: "/about",
        param: "/:slug",
      });

      expect(tryTrieMatch(trie, "//about")).toBeNull();
    });

    it("treats percent-encoded slash in a segment as a literal value", () => {
      const trie = buildTestTrie({
        "blog.post": "/blog/:slug",
      });

      const result = tryTrieMatch(trie, "/blog/hello%2Fworld");
      expect(result?.params).toEqual({ slug: "hello%2Fworld" });
    });

    it("treats empty pathname as root match", () => {
      const trie = buildTestTrie({ home: "/" });
      const result = tryTrieMatch(trie, "");
      expect(result?.routeKey).toBe("home");
    });

    it("handles very long pathnames without crashing", () => {
      const trie = buildTestTrie({
        "files.any": "/files/*",
      });

      const longPath = "/files/" + "a".repeat(8000);
      const result = tryTrieMatch(trie, longPath);
      expect(result?.routeKey).toBe("files.any");
      expect(result?.params["*"]).toHaveLength(8000);
    });

    it("captures percent-encoded characters in param values", () => {
      const trie = buildTestTrie({
        "user.profile": "/user/:name",
      });

      // The trie matches against the raw pathname; encoding is the caller's concern
      const result = tryTrieMatch(trie, "/user/hello%20world");
      expect(result?.params).toEqual({ name: "hello%20world" });
    });
  });
});
