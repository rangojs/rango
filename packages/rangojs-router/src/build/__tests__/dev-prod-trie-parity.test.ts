import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { urls } from "../../urls.js";
import { generateManifestFull } from "../generate-manifest.js";
import { buildPerRouterTrie, type TrieNode } from "../route-trie.js";
import { tryTrieMatch } from "../../router/trie-matching.js";

// Regression (C12 / R1): production serializes the build-time trie while dev
// rebuilds it per request. Both now go through the SAME buildPerRouterTrie
// helper, so the only input difference is the mountIndex passed to
// generateManifestFull (dev: undefined -> 0 for every router; prod: a global
// 0,1,2... counter). mountIndex only feeds the debug-only leaf `a` ancestry.
// This test pins that the two trie-construction inputs produce identical match
// behavior and structurally identical tries (modulo `a`).

const Page = createElement("div");

// A deliberately non-trivial single-router tree: static, optional+required
// params, suffix param, wildcard, trailing-slash config, and a nested include.
function makePatterns() {
  return urls<any>(({ path, layout, include }) => [
    layout(Page, () => [
      path("/", Page, { name: "home" }),
      path("/about", Page, { name: "about", trailingSlash: "always" }),
      path("/shop/:cat?/:id", Page, { name: "product" }),
      path("/p/:id.html", Page, { name: "html" }),
      path("/files/*", Page, { name: "files" }),
      include(
        "/blog",
        urls<any>(({ path: p }) => [
          p("/", Page, { name: "index" }),
          p("/:slug", Page, { name: "post" }),
        ]),
        { name: "blog" },
      ),
    ]),
  ]);
}

// Recursively strip the debug-only `a` (ancestry) field from every leaf so two
// tries built with different mount indices can be compared structurally.
function stripAncestry(node: TrieNode | undefined): any {
  if (!node) return node;
  const out: any = {};
  if (node.r) {
    const { a: _a, ...rest } = node.r as any;
    out.r = rest;
  }
  if (node.w) {
    const { a: _a, ...rest } = node.w as any;
    out.w = rest;
  }
  if (node.s) {
    out.s = {};
    for (const [k, child] of Object.entries(node.s)) {
      out.s[k] = stripAncestry(child);
    }
  }
  if (node.p) {
    out.p = { n: node.p.n, c: stripAncestry(node.p.c) };
  }
  if (node.xp) {
    out.xp = {};
    for (const [k, child] of Object.entries(node.xp)) {
      out.xp[k] = { n: child.n, c: stripAncestry(child.c) };
    }
  }
  return out;
}

const PROBE_URLS = [
  "/",
  "/about",
  "/about/",
  "/shop/widget",
  "/shop/tools/widget",
  "/p/5.html",
  "/files",
  "/files/a/b/c",
  "/blog",
  "/blog/hello",
  "/nope",
];

describe("dev/prod per-router trie parity (buildPerRouterTrie)", () => {
  it("dev (mountIndex undefined->0) equals prod router-0 exactly", () => {
    const patterns = makePatterns();
    const devTrie = buildPerRouterTrie(
      generateManifestFull(patterns, undefined),
    );
    const prodTrie = buildPerRouterTrie(generateManifestFull(patterns, 0));
    expect(devTrie).toEqual(prodTrie);
  });

  it("a 2nd-router prod trie (mountIndex 1) differs only in leaf ancestry", () => {
    const patterns = makePatterns();
    const devTrie = buildPerRouterTrie(
      generateManifestFull(patterns, undefined),
    );
    const prodR1Trie = buildPerRouterTrie(generateManifestFull(patterns, 1));
    // Raw tries differ (leaf.a embeds the mount index)...
    expect(devTrie).not.toEqual(prodR1Trie);
    // ...but only in the debug-only ancestry: structurally identical otherwise.
    expect(stripAncestry(devTrie!)).toEqual(stripAncestry(prodR1Trie!));
  });

  it("match results are identical across mount indices for every probe URL", () => {
    const patterns = makePatterns();
    const devTrie = buildPerRouterTrie(
      generateManifestFull(patterns, undefined),
    );
    const prodR1Trie = buildPerRouterTrie(generateManifestFull(patterns, 1));
    for (const url of PROBE_URLS) {
      expect(tryTrieMatch(devTrie, url)).toEqual(tryTrieMatch(prodR1Trie, url));
    }
  });
});
