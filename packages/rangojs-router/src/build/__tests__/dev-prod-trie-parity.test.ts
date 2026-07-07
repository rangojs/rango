import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { urls } from "../../urls.js";
import { generateManifestFull } from "../generate-manifest.js";
import { buildPerRouterTrie } from "../route-trie.js";
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
      path("/p/:id.full.html", Page, { name: "htmlfull" }),
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

const PROBE_URLS = [
  "/",
  "/about",
  "/about/",
  "/shop/widget",
  "/shop/tools/widget",
  "/p/5.html",
  "/p/5.full.html",
  "/files",
  "/files/a/b/c",
  "/blog",
  "/blog/hello",
  "/nope",
];

describe("dev/prod per-router trie parity (buildPerRouterTrie)", () => {
  it("dev (mountIndex undefined->0) equals prod router-0 exactly", async () => {
    const patterns = makePatterns();
    const devTrie = buildPerRouterTrie(
      await generateManifestFull(patterns, undefined),
    );
    const prodTrie = buildPerRouterTrie(
      await generateManifestFull(patterns, 0),
    );
    expect(devTrie).toEqual(prodTrie);
  });

  it("a 2nd-router prod trie (mountIndex 1) is byte-identical", async () => {
    const patterns = makePatterns();
    const devTrie = buildPerRouterTrie(
      await generateManifestFull(patterns, undefined),
    );
    const prodR1Trie = buildPerRouterTrie(
      await generateManifestFull(patterns, 1),
    );
    // The trie carries no mount-index-dependent data (the debug-only leaf
    // ancestry that used to embed it was removed), so it is fully
    // mount-index-independent — identical across every router slot.
    expect(devTrie).toEqual(prodR1Trie);
  });

  it("match results are identical across mount indices for every probe URL", async () => {
    const patterns = makePatterns();
    const devTrie = buildPerRouterTrie(
      await generateManifestFull(patterns, undefined),
    );
    const prodR1Trie = buildPerRouterTrie(
      await generateManifestFull(patterns, 1),
    );
    for (const url of PROBE_URLS) {
      expect(tryTrieMatch(devTrie, url)).toEqual(tryTrieMatch(prodR1Trie, url));
    }
  });
});
