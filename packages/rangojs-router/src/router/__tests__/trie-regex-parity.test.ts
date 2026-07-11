import { describe, it, expect } from "vitest";
import { buildRouteTrie } from "../../build/route-trie.js";
import { tryTrieMatch } from "../trie-matching.js";
import {
  findMatch as rawFindMatch,
  extractStaticPrefix,
  isLazyEvaluationNeeded,
  type RouteMatchResult,
} from "../pattern-matching.js";
import type { RouteEntry } from "../../types.js";

// Regression (C11 / M6): the trie (Phase 1) is the live matcher in both dev and
// production; the regex fallback (Phase 2) is a should-not-happen safety net.
// This test pins that the two matchers AGREE on the common surface, and
// documents the known, intentional divergences (the regex path is deficient by
// design — see docs/internal/matching-and-lazy-discovery.md M3/M4/C1).

// Build a trie + a single flat RouteEntry from the same routes so both matchers
// see identical input. sp is synthetic — it does not affect the matched
// (routeKey, params, redirectTo) which is what parity compares.
function buildBoth(
  routes: Record<string, string>,
  ts?: Record<string, string>,
) {
  const sp: Record<string, string> = {};
  for (const [name, pattern] of Object.entries(routes)) {
    sp[name] = extractStaticPrefix(pattern);
  }
  const trie = buildRouteTrie(routes, sp, ts);
  const entry = {
    prefix: "",
    staticPrefix: "",
    routes,
    ...(ts ? { trailingSlash: ts } : {}),
  } as unknown as RouteEntry;
  return { trie, entries: [entry] };
}

function norm(r: RouteMatchResult<any> | TrieMatchLike | null) {
  if (!r) return null;
  return {
    routeKey: (r as any).routeKey,
    params: (r as any).params,
    redirectTo: (r as any).redirectTo ?? null,
  };
}
type TrieMatchLike = ReturnType<typeof tryTrieMatch>;

function regex(entries: RouteEntry[], url: string) {
  const r = rawFindMatch(url, entries);
  if (r && isLazyEvaluationNeeded(r)) {
    throw new Error("unexpected lazy result in parity test");
  }
  return r as RouteMatchResult<any> | null;
}

describe("trie vs regex matcher parity (stable surface)", () => {
  // Each row: routes that DO agree between the two matchers, and probe URLs.
  const AGREEING: Array<{
    name: string;
    routes: Record<string, string>;
    ts?: Record<string, string>;
    urls: string[];
  }> = [
    {
      name: "static beats param (static declared first)",
      routes: { "docs.static": "/docs/new", "docs.param": "/docs/:slug" },
      urls: ["/docs/new", "/docs/anything"],
    },
    {
      name: "optional middle params + required tail",
      routes: { cat: "/shop/:a?/:b?/:id" },
      urls: ["/shop/tops", "/shop/women/dresses", "/shop/a/b/c"],
    },
    {
      name: "suffix param vs plain param",
      routes: { html: "/p/:id.html", plain: "/p/:id" },
      urls: ["/p/5.html", "/p/5"],
    },
    {
      name: "constrained param",
      routes: { loc: "/:locale(en|gb)/blog" },
      urls: ["/en/blog", "/gb/blog", "/fr/blog"],
    },
    {
      name: "wildcard for deeper paths",
      routes: { "files.deep": "/files/:a/:b", any: "/files/*" },
      urls: ["/files/x/y", "/files/x/y/z"],
    },
    {
      name: "explicit trailing-slash modes agree",
      routes: { ig: "/ig", al: "/al", ne: "/ne" },
      ts: { ig: "ignore", al: "always", ne: "never" },
      urls: ["/ig", "/ig/", "/al", "/al/", "/ne", "/ne/"],
    },
    {
      name: "exact static + param matches (no trailing-slash ambiguity)",
      routes: { home: "/", about: "/about", post: "/blog/:slug" },
      urls: ["/", "/about", "/blog/hello"],
    },
    {
      // A1: an empty path segment (double slash) must NOT bind a REQUIRED param
      // to "". Both matchers reject it (regex `([^/]+)` needs 1+ chars; the trie
      // now guards the plain-param branch with `segment !== ""`). A non-empty
      // segment still matches normally.
      name: "empty required-param segment is rejected by both",
      routes: { A: "/a/:s/b" },
      urls: ["/a//b", "/a/x/b"],
    },
    {
      // Named catch-all `:name+` (one-or-more): matches 1+ trailing segments,
      // rejects the bare prefix. Both matchers agree on all three, including the
      // null on "/docs" (regex `(.+)` needs a char; trie's one-or-more flag
      // suppresses the empty-remainder terminal). Issue #634.
      name: "named catch-all one-or-more",
      routes: { "docs.any": "/docs/:slug+" },
      urls: ["/docs/a", "/docs/a/b/c", "/docs"],
    },
    {
      // Named catch-all `:name*` (zero-or-more). Review F6 aligned the regex
      // fallback with the trie on the bare prefix, so "/blog" agrees too (both
      // bind rest === "").
      name: "named catch-all zero-or-more (incl. bare prefix)",
      routes: { "blog.any": "/blog/:rest*" },
      urls: ["/blog", "/blog/a", "/blog/a/b"],
    },
    {
      // Bare `*` (zero-or-more, unnamed). Issue #636 aligned the regex fallback
      // with the trie on the bare prefix — the same F6 shape #635 applied to
      // `:name*`. "/files" now matches on BOTH matchers binding "*" === ""
      // (previously the regex emitted a corrupt "/file" redirect — the old C1
      // divergence, now removed from the documented-divergences block below).
      name: "bare wildcard zero-or-more (incl. bare prefix)",
      routes: { any: "/files/*" },
      urls: ["/files", "/files/a", "/files/a/b"],
    },
  ];

  for (const row of AGREEING) {
    it(`agrees: ${row.name}`, () => {
      const { trie, entries } = buildBoth(row.routes, row.ts);
      for (const url of row.urls) {
        expect({ url, ...(norm(tryTrieMatch(trie, url)) ?? {}) }).toEqual({
          url,
          ...(norm(regex(entries, url)) ?? {}),
        });
      }
    });
  }

  // The trie is canonical. These rows document where the regex fallback
  // intentionally differs so a future change to either matcher is noticed.
  describe("documented divergences (trie is canonical)", () => {
    // C1 (bare `*` regex emits a corrupt `/file` redirect on the bare prefix)
    // was fixed in #636 — the regex fallback now matches the bare prefix binding
    // "*" === "", the same as the trie. See the "bare wildcard zero-or-more
    // (incl. bare prefix)" agreeing row above.

    it("M4: trie picks by specificity; regex by definition order", () => {
      // param declared BEFORE static.
      const { trie, entries } = buildBoth({
        param: "/docs/:slug",
        stat: "/docs/new",
      });
      expect(tryTrieMatch(trie, "/docs/new")?.routeKey).toBe("stat");
      expect(regex(entries, "/docs/new")?.routeKey).toBe("param");
    });

    it("M4 (suffix): trie picks the longest suffix; regex by declaration order", () => {
      // Overlapping suffixes, shorter `.js` declared BEFORE `.min.js`.
      const { trie, entries } = buildBoth({
        js: "/assets/:file.js",
        minjs: "/assets/:file.min.js",
      });
      // Trie (live matcher) picks the most specific suffix.
      expect(tryTrieMatch(trie, "/assets/app.min.js")?.routeKey).toBe("minjs");
      expect(tryTrieMatch(trie, "/assets/app.min.js")?.params).toEqual({
        file: "app",
      });
      // Regex fallback matches the first-declared overlapping suffix.
      expect(regex(entries, "/assets/app.min.js")?.routeKey).toBe("js");
      expect(regex(entries, "/assets/app.min.js")?.params).toEqual({
        file: "app.min",
      });
    });

    it("M3: trie serves the alternate slash with no redirect when no ts mode; regex canonicalizes", () => {
      const { trie, entries } = buildBoth({ foo: "/foo" });
      expect(norm(tryTrieMatch(trie, "/foo/"))).toEqual({
        routeKey: "foo",
        params: {},
        redirectTo: null,
      });
      expect(norm(regex(entries, "/foo/"))?.redirectTo).toBe("/foo");
    });

    // A6: wildcard splat trailing-slash capture. Under `ignore` (or no-ts)
    // modes the regex fallback matches a trailing-slash URL via its
    // alternatePathname branch, and its greedy `(.*)` group eats the trailing
    // slash into the splat param. The canonical trie strips a single trailing
    // slash before splitting segments (trie-matching.ts normalizedPath +
    // joinRemainingSegments), so the splat has no trailing slash. Both match the
    // wildcard route with NO redirect, so the divergent splat value is
    // consumer-visible on the documented lazy-include lag / trie-absent fallback
    // path. The trie is canonical; this row pins the exact values so the gap
    // cannot silently widen (e.g. the regex starting to ALSO strip, or the trie
    // starting to keep).
    it("A6: regex leaks a trailing slash into the splat; trie strips it", () => {
      const { trie, entries } = buildBoth(
        { any: "/blog/*" },
        { any: "ignore" },
      );

      // Deep path with a trailing slash: trie "x/y", regex "x/y/".
      const trieDeep = tryTrieMatch(trie, "/blog/x/y/");
      const regexDeep = regex(entries, "/blog/x/y/");
      expect(trieDeep?.routeKey).toBe("any");
      expect(regexDeep?.routeKey).toBe("any");
      expect(trieDeep?.redirectTo ?? null).toBeNull();
      expect(regexDeep?.redirectTo ?? null).toBeNull();
      expect(trieDeep?.params).toEqual({ "*": "x/y" });
      expect(regexDeep?.params).toEqual({ "*": "x/y/" });

      // Bare double slash: trie "", regex "/".
      const trieBare = tryTrieMatch(trie, "/blog//");
      const regexBare = regex(entries, "/blog//");
      expect(trieBare?.params).toEqual({ "*": "" });
      expect(regexBare?.params).toEqual({ "*": "/" });

      // Sanity: with NO trailing slash the two matchers AGREE on the splat.
      expect(tryTrieMatch(trie, "/blog/x/y")?.params).toEqual({ "*": "x/y" });
      expect(regex(entries, "/blog/x/y")?.params).toEqual({ "*": "x/y" });
    });
  });
});
