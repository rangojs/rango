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

  it("leaves absent optional params undefined (omits the key from params)", () => {
    const trie = buildTestTrie({
      "shop.locale": "/shop/:locale(en|gb)?",
    });

    expect(tryTrieMatch(trie, "/shop")?.params).toEqual({});
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

  // Regression (C1): a wildcard whose parent node is reached with no remaining
  // segments must match the bare prefix with an empty remainder. Previously the
  // trie missed and the regex fallback emitted a corrupt slice-off redirect
  // ("/files" -> "/file").
  it("matches the bare wildcard prefix with an empty remainder", () => {
    const trie = buildTestTrie({
      "files.any": "/files/*",
    });

    expect(tryTrieMatch(trie, "/files")?.routeKey).toBe("files.any");
    expect(tryTrieMatch(trie, "/files")?.params).toEqual({ "*": "" });
    expect(tryTrieMatch(trie, "/files")?.redirectTo).toBeUndefined();
    // Trailing-slash form normalizes to the same bare-prefix match.
    expect(tryTrieMatch(trie, "/files/")?.routeKey).toBe("files.any");
    expect(tryTrieMatch(trie, "/files/")?.params).toEqual({ "*": "" });
  });

  it("matches a root-level wildcard against '/' with an empty remainder", () => {
    const trie = buildTestTrie({ "catch.all": "/*" });

    expect(tryTrieMatch(trie, "/")?.routeKey).toBe("catch.all");
    expect(tryTrieMatch(trie, "/")?.params).toEqual({ "*": "" });
  });

  it("prefers a static terminal over a wildcard at the same prefix", () => {
    const trie = buildTestTrie({
      "files.index": "/files",
      "files.any": "/files/*",
    });

    // Bare prefix: the static index wins, not the wildcard.
    expect(tryTrieMatch(trie, "/files")?.routeKey).toBe("files.index");
    // Deeper path: only the wildcard can match.
    expect(tryTrieMatch(trie, "/files/a/b")?.routeKey).toBe("files.any");
    expect(tryTrieMatch(trie, "/files/a/b")?.params).toEqual({ "*": "a/b" });
  });

  // The bare-prefix wildcard match (C1) generalizes to a PARAM-prefixed wildcard:
  // "/users/:id/*" matches "/users/5" with an empty splat (zero-or-more splat
  // semantics, like React Router). Params bound before the wildcard are kept.
  it("matches a param-prefixed wildcard at its bare prefix with an empty remainder", () => {
    const trie = buildTestTrie({ "users.any": "/users/:id/*" });

    expect(tryTrieMatch(trie, "/users/5")?.routeKey).toBe("users.any");
    expect(tryTrieMatch(trie, "/users/5")?.params).toEqual({
      id: "5",
      "*": "",
    });
    // A deeper path keeps the splat remainder alongside the bound param.
    expect(tryTrieMatch(trie, "/users/5/posts/3")?.params).toEqual({
      id: "5",
      "*": "posts/3",
    });
  });

  it("prefers a param terminal over the param-prefixed wildcard at the bare prefix", () => {
    const trie = buildTestTrie({
      "users.show": "/users/:id",
      "users.any": "/users/:id/*",
    });

    // Bare "/users/5": the param terminal wins over the wildcard.
    expect(tryTrieMatch(trie, "/users/5")?.routeKey).toBe("users.show");
    expect(tryTrieMatch(trie, "/users/5")?.params).toEqual({ id: "5" });
    // Deeper: only the wildcard can match.
    expect(tryTrieMatch(trie, "/users/5/x")?.routeKey).toBe("users.any");
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

    it("decodes percent-encoded slash in a segment to a literal value", () => {
      const trie = buildTestTrie({
        "blog.post": "/blog/:slug",
      });

      // Params are decoded at the extraction boundary so apps see the
      // raw string value ("hello/world") not the URL-encoded form. This
      // matches Express/React Router/Fastify/Koa and keeps round-trips
      // through reverse (which re-encodes) stable.
      const result = tryTrieMatch(trie, "/blog/hello%2Fworld");
      expect(result?.params).toEqual({ slug: "hello/world" });
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

    it("decodes percent-encoded characters in param values", () => {
      const trie = buildTestTrie({
        "user.profile": "/user/:name",
      });

      const result = tryTrieMatch(trie, "/user/hello%20world");
      expect(result?.params).toEqual({ name: "hello world" });
    });

    it("preserves malformed percent-encoding as the raw string", () => {
      const trie = buildTestTrie({
        "user.profile": "/user/:name",
      });

      // Standalone % (not a valid escape) would throw from decodeURIComponent;
      // safeDecodeURIComponent falls back to the raw value so the handler can
      // decide how to respond instead of the router crashing.
      const result = tryTrieMatch(trie, "/user/broken%ZZ");
      expect(result?.params).toEqual({ name: "broken%ZZ" });
    });

    it("decodes reserved characters in param values (e.g. @ in emails)", () => {
      const trie = buildTestTrie({
        "mailbox.show": "/mailbox/:mailboxId",
      });

      const result = tryTrieMatch(trie, "/mailbox/ivo%40example.com");
      expect(result?.params).toEqual({ mailboxId: "ivo@example.com" });
    });
  });

  describe("optional middle params followed by a required tail", () => {
    // Regression: with the trie matcher, a chain of optional params followed by
    // a required tail param used to silently mis-assign captures positionally
    // to the front of `pa`, leaving the tail param undefined.
    // The regex matcher (compilePattern) returns the right answer; the trie
    // must match it.

    it("places the lone segment in the required tail when all optionals are skipped", () => {
      const trie = buildTestTrie({
        category: "/shop/:b1?/:b2?/:b3?/:b4?/:b5?/:b6?/:categoryId",
      });

      const result = tryTrieMatch(trie, "/shop/tops");
      expect(result?.routeKey).toBe("category");
      expect(result?.params).toEqual({ categoryId: "tops" });
    });

    it("fills optionals left-to-right and binds the required tail to the last segment", () => {
      const trie = buildTestTrie({
        category: "/shop/:b1?/:b2?/:b3?/:b4?/:b5?/:b6?/:categoryId",
      });

      expect(tryTrieMatch(trie, "/shop/women/dresses")?.params).toEqual({
        b1: "women",
        categoryId: "dresses",
      });

      expect(
        tryTrieMatch(trie, "/shop/women/clothing/dresses")?.params,
      ).toEqual({
        b1: "women",
        b2: "clothing",
        categoryId: "dresses",
      });
    });

    it("binds every slot when all optionals are filled", () => {
      const trie = buildTestTrie({
        category: "/shop/:b1?/:b2?/:b3?/:b4?/:b5?/:b6?/:categoryId",
      });

      expect(tryTrieMatch(trie, "/shop/a/b/c/d/e/f/dresses")?.params).toEqual({
        b1: "a",
        b2: "b",
        b3: "c",
        b4: "d",
        b5: "e",
        b6: "f",
        categoryId: "dresses",
      });
    });

    it("works for a smaller chain too (3 optionals + required tail)", () => {
      const trie = buildTestTrie({
        cat: "/shop/:b1?/:b2?/:b3?/:categoryId",
      });

      expect(tryTrieMatch(trie, "/shop/tops")?.params).toEqual({
        categoryId: "tops",
      });
      expect(tryTrieMatch(trie, "/shop/women/dresses")?.params).toEqual({
        b1: "women",
        categoryId: "dresses",
      });
      expect(tryTrieMatch(trie, "/shop/a/b/c/dresses")?.params).toEqual({
        b1: "a",
        b2: "b",
        b3: "c",
        categoryId: "dresses",
      });
    });

    it("handles a single optional before a required (no static prefix)", () => {
      const trie = buildTestTrie({
        x: "/:a?/:b",
      });

      expect(tryTrieMatch(trie, "/only")?.params).toEqual({ b: "only" });
      expect(tryTrieMatch(trie, "/foo/bar")?.params).toEqual({
        a: "foo",
        b: "bar",
      });
    });

    it("respects constraints on an optional before the required tail", () => {
      const trie = buildTestTrie({
        post: "/:locale(en|gb)?/:slug",
      });

      // optional absent → bind only :slug
      expect(tryTrieMatch(trie, "/hello")?.params).toEqual({ slug: "hello" });
      // optional present, satisfies constraint
      expect(tryTrieMatch(trie, "/en/hello")?.params).toEqual({
        locale: "en",
        slug: "hello",
      });
      // optional present, violates constraint → reject
      expect(tryTrieMatch(trie, "/de/hello")).toBeNull();
    });

    it("handles required → optionals → required (mixed shape)", () => {
      const trie = buildTestTrie({
        m: "/:nonopt/:a?/:b?/:nonopt2",
      });

      // 2 segments: only the two required slots are bound
      expect(tryTrieMatch(trie, "/X/Y")?.params).toEqual({
        nonopt: "X",
        nonopt2: "Y",
      });
      // 3 segments: greedy-left fills :a, :b stays absent
      expect(tryTrieMatch(trie, "/X/Y/Z")?.params).toEqual({
        nonopt: "X",
        a: "Y",
        nonopt2: "Z",
      });
      // 4 segments: both optionals filled
      expect(tryTrieMatch(trie, "/X/Y/Z/W")?.params).toEqual({
        nonopt: "X",
        a: "Y",
        b: "Z",
        nonopt2: "W",
      });
    });
  });
});
