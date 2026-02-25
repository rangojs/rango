import { bench, describe } from "vitest";
import { buildRouteTrie } from "../../build/route-trie";
import { tryTrieMatch } from "../trie-matching";
import { findMatch, extractStaticPrefix } from "../pattern-matching";
import type { RouteEntry } from "../../types";

const routeManifest: Record<string, string> = {
  home: "/",
};
const routeAncestry: Record<string, string[]> = {
  home: ["M0L0R0"],
};
const routeToStaticPrefix: Record<string, string> = { home: "" };

for (let i = 0; i < 1200; i++) {
  const key = `blog.post${i}`;
  routeManifest[key] = `/blog/${i}/:slug`;
  routeAncestry[key] = ["M0L0", `M0L0R${i}`];
  routeToStaticPrefix[key] = "/blog";
}
for (let i = 0; i < 800; i++) {
  const key = `shop.category${i}`;
  routeManifest[key] = `/shop/:locale(en|gb)?/cat-${i}/:item`;
  routeAncestry[key] = ["M1L0", `M1L0R${i}`];
  routeToStaticPrefix[key] = "/shop";
}
routeManifest["docs.catchall"] = "/docs/*";
routeAncestry["docs.catchall"] = ["M2L0", "M2L0R0"];
routeToStaticPrefix["docs.catchall"] = "/docs";

const trie = buildRouteTrie(routeManifest, routeAncestry, routeToStaticPrefix);

const entries: RouteEntry[] = [
  {
    prefix: "",
    staticPrefix: extractStaticPrefix(""),
    routes: routeManifest as any,
    handler: () => [],
    mountIndex: 0,
  },
];

describe("router matching baseline", () => {
  bench("tryTrieMatch dynamic route", () => {
    tryTrieMatch(trie, "/shop/en/cat-777/abc-123");
  });

  bench("tryTrieMatch wildcard route", () => {
    tryTrieMatch(trie, "/docs/a/b/c/d/e/f");
  });

  bench("findMatch regex fallback dynamic route", () => {
    findMatch("/shop/en/cat-777/abc-123", entries);
  });
});
