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
// see identical input. sp/ancestry are synthetic — they do not affect the
// matched (routeKey, params, redirectTo) which is what parity compares.
function buildBoth(
  routes: Record<string, string>,
  ts?: Record<string, string>,
) {
  const ancestry: Record<string, string[]> = {};
  const sp: Record<string, string> = {};
  for (const [name, pattern] of Object.entries(routes)) {
    ancestry[name] = [`A:${name}`];
    sp[name] = extractStaticPrefix(pattern);
  }
  const trie = buildRouteTrie(routes, ancestry, sp, ts);
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
    it("C1: trie matches the bare wildcard prefix; regex emits a corrupt redirect", () => {
      const { trie, entries } = buildBoth({ any: "/files/*" });
      // Trie (the live matcher) matches with an empty splat, no redirect.
      expect(norm(tryTrieMatch(trie, "/files"))).toEqual({
        routeKey: "any",
        params: { "*": "" },
        redirectTo: null,
      });
      // Regex fallback (never reached in normal operation) redirects to /file.
      expect(norm(regex(entries, "/files"))?.redirectTo).toBe("/file");
    });

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
  });
});
