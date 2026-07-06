/**
 * Route-structure data for the home screen's prefix-tree map.
 *
 * One entry per top-level group in src/urls.tsx. The home page renders this
 * verbatim — when a group is added (e.g. by the scale generator), append an
 * entry here and the map, counts, and sample links stay truthful without
 * touching JSX. Counts are display strings; keep them in sync with the
 * pattern modules they describe.
 */

export interface GroupLink {
  path: string;
  label: string;
}

export interface RouteGroup {
  id: string;
  /** URL prefix as written in urls.tsx ("" for the eager root entry). */
  prefix: string;
  chunk: "eager" | "async";
  /** Display count, e.g. "~9,000". */
  count: string;
  /** What this group exists to stress. */
  stresses: string;
  /** Nested include prefixes, when the group's module declares its own. */
  nested?: string[];
  /** A few real, clickable entry points into the group. */
  links: GroupLink[];
  /** Categorical color slot (validated palette order), 1-based. */
  slot: 1 | 2 | 3 | 4 | 5;
}

export const routeGroups: RouteGroup[] = [
  {
    id: "root",
    prefix: "/",
    chunk: "eager",
    count: "7",
    stresses: "worker entry — always parsed at cold start",
    links: [
      { path: "/bench/first", label: "bench/first" },
      { path: "/bench/last", label: "bench/last" },
      { path: "/links", label: "links demo" },
    ],
    slot: 1,
  },
  {
    id: "site",
    prefix: "/site/:locale",
    chunk: "async",
    count: "~9,000",
    stresses: "manifest size, param matching, 4-level nested layouts",
    links: [
      { path: "/site/en/bench/first", label: "en bench" },
      { path: "/site/fr/bench/first", label: "fr bench" },
      { path: "/site/en/l4/1/t0/id1", label: "l4 nested" },
      { path: "/site/en/flat/1", label: "flat" },
    ],
    slot: 2,
  },
  {
    id: "api",
    prefix: "/api",
    chunk: "async",
    count: "~5,000",
    stresses: "param shapes: :id, multi-param, optional, static",
    links: [
      { path: "/api/bench/first", label: "bench" },
      { path: "/api/v1/resource1/42", label: "v1 :id" },
      { path: "/api/v2/users/u1/items1/i1", label: "v2 multi" },
      { path: "/api/v4/static/1", label: "v4 static" },
    ],
    slot: 3,
  },
  {
    id: "shop",
    prefix: "/shop",
    chunk: "async",
    count: "~200",
    stresses: "nested includes spliced on first hit",
    nested: ["/shop/product", "/shop/category"],
    links: [
      { path: "/shop/product/1", label: "product 1" },
      { path: "/shop/category/1", label: "category 1" },
    ],
    slot: 4,
  },
  {
    id: "json-api",
    prefix: "/json-api",
    chunk: "async",
    count: "4",
    stresses: "typed path.json responses (PathResponse inference)",
    links: [
      { path: "/json-api/health", label: "health" },
      { path: "/json-api/items/42", label: "items/:id" },
    ],
    slot: 5,
  },
  {
    id: "app",
    prefix: "/app",
    chunk: "async",
    count: "3",
    stresses: "loaders in parallel, cache() segment, server action",
    links: [
      { path: "/app/dashboard/main", label: "dashboard (3 loaders)" },
      { path: "/app/cached/hot", label: "cached segment" },
      { path: "/app/feedback", label: "action form" },
    ],
    slot: 1,
  },
  {
    id: "hub",
    prefix: "/g",
    chunk: "async",
    count: "12,000",
    stresses:
      "50 sibling async chunks; deep static, 5-param, suffix, catch-all shapes",
    nested: ["/g/g001 … /g/g050"],
    links: [
      { path: "/g/g001/bench/first", label: "g001 bench" },
      { path: "/g/g001/tree/a/b/c", label: ":rest+ catch-all" },
      { path: "/g/g001/files/app.min.js", label: "suffix param" },
      { path: "/g/g050/whoami/g050", label: "g050" },
    ],
    slot: 2,
  },
  {
    id: "mega",
    prefix: "/mega",
    chunk: "async",
    count: "90",
    stresses: "3-level async include chain — deepest hit awaits 3 imports",
    nested: ["/mega/l2", "/mega/l2/l3"],
    links: [
      { path: "/mega/p1", label: "level 1" },
      { path: "/mega/l2/l3/p1/x", label: "level 3" },
    ],
    slot: 3,
  },
  {
    id: "site-admin",
    prefix: "/site-admin",
    chunk: "async",
    count: "40",
    stresses: "string-prefix overlap with /site (segment-wise handling)",
    links: [{ path: "/site-admin/p1", label: "p1" }],
    slot: 4,
  },
  {
    id: "dup",
    prefix: "/dup/:cat | /dup/:brand",
    chunk: "async",
    count: "10",
    stresses: "same-staticPrefix siblings — both chunks load on first /dup hit",
    links: [
      { path: "/dup/shoes/cat-page1", label: "cat sibling" },
      { path: "/dup/acme/brand-page1", label: "brand sibling" },
    ],
    slot: 5,
  },
];
