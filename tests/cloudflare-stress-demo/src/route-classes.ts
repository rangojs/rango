/**
 * Route-class descriptors for the benchmark dashboard.
 *
 * The app's 26k routes are parametric (loop-generated shapes), so the
 * clickable surface is expressed as ~20 CLASSES with param inputs instead of
 * a link list. Pure data + builders; imported directly by the client
 * dashboard (functions cannot cross the RSC props boundary).
 */

export interface ClassInput {
  name: string;
  label: string;
  kind: "locale" | "number" | "text";
  /** For kind "number": the route family exists for 1..max. */
  max?: number;
  defaultValue: string;
}

export interface RouteClass {
  id: string;
  label: string;
  group: string;
  /** Human-readable pattern, shown next to the picker. */
  template: string;
  inputs: ClassInput[];
  build(values: Record<string, string>): string;
  /** What a correct response looks like; drives accept header + status chip. */
  expects: "json" | "html" | "miss";
  note?: string;
}

export const LOCALES: string[] = ["en", "fr", "de", "ja", "es"];

const locale = (defaultValue = "en"): ClassInput => ({
  name: "locale",
  label: "locale",
  kind: "locale",
  defaultValue,
});
const num = (name: string, max: number, defaultValue = "1"): ClassInput => ({
  name,
  label: `${name} (1-${max})`,
  kind: "number",
  max,
  defaultValue,
});
const text = (name: string, defaultValue: string): ClassInput => ({
  name,
  label: name,
  kind: "text",
  defaultValue,
});

export const routeClasses: RouteClass[] = [
  // -- Root --
  {
    id: "root-bench-first",
    label: "Bench first (raw JSON)",
    group: "Root",
    template: "/bench/first",
    inputs: [],
    build: () => "/bench/first",
    expects: "json",
  },
  {
    id: "home-ssr",
    label: "Home (SSR document)",
    group: "Root",
    template: "/",
    inputs: [],
    build: () => "/",
    expects: "html",
  },

  // -- API group (async include /api) --
  {
    id: "api-resource",
    label: "Resource with :id",
    group: "API (/api)",
    template: "/api/v1/resource<n>/:id",
    inputs: [num("n", 1000), text("id", "42")],
    build: (v) => `/api/v1/resource${v.n}/${v.id}`,
    expects: "html",
  },
  {
    id: "api-user-items",
    label: "Multi-param nested",
    group: "API (/api)",
    template: "/api/v2/users/:userId/items<n>/:itemId",
    inputs: [text("userId", "u1"), num("n", 1000), text("itemId", "i1")],
    build: (v) => `/api/v2/users/${v.userId}/items${v.n}/${v.itemId}`,
    expects: "html",
  },
  {
    id: "api-search-optional",
    label: "Optional param",
    group: "API (/api)",
    template: "/api/v3/search<n>/:query?",
    inputs: [num("n", 1000), text("query", "")],
    build: (v) => `/api/v3/search${v.n}${v.query ? `/${v.query}` : ""}`,
    expects: "html",
  },
  {
    id: "api-static",
    label: "Static route",
    group: "API (/api)",
    template: "/api/v4/static/<n>",
    inputs: [num("n", 1000)],
    build: (v) => `/api/v4/static/${v.n}`,
    expects: "html",
  },

  // -- Site group (async include /site/:locale) --
  {
    id: "site-user",
    label: "User with :id",
    group: "Site (/site/:locale)",
    template: "/site/:locale/user<n>/:id",
    inputs: [locale(), num("n", 1000), text("id", "7")],
    build: (v) => `/site/${v.locale}/user${v.n}/${v.id}`,
    expects: "html",
  },
  {
    id: "site-flat",
    label: "Flat static",
    group: "Site (/site/:locale)",
    template: "/site/:locale/flat/<n>",
    inputs: [locale(), num("n", 2000)],
    build: (v) => `/site/${v.locale}/flat/${v.n}`,
    expects: "html",
  },
  {
    id: "site-l4",
    label: "4-level nested layout",
    group: "Site (/site/:locale)",
    template: "/site/:locale/l4/<n>/:type/:id?",
    inputs: [locale(), num("n", 1000), text("type", "t0"), text("id", "id1")],
    build: (v) =>
      `/site/${v.locale}/l4/${v.n}/${v.type}${v.id ? `/${v.id}` : ""}`,
    expects: "html",
    note: "deepest segment tree in the app",
  },

  // -- Shop (nested includes) --
  {
    id: "shop-product",
    label: "Product page",
    group: "Shop (nested includes)",
    template: "/shop/product/<n>",
    inputs: [num("n", 100)],
    build: (v) => `/shop/product/${v.n}`,
    expects: "html",
  },
  {
    id: "shop-category",
    label: "Category page",
    group: "Shop (nested includes)",
    template: "/shop/category/<n>",
    inputs: [num("n", 100)],
    build: (v) => `/shop/category/${v.n}`,
    expects: "html",
  },

  // -- JSON API (typed response routes) --
  {
    id: "json-health",
    label: "Health (path.json)",
    group: "JSON API (/json-api)",
    template: "/json-api/health",
    inputs: [],
    build: () => "/json-api/health",
    expects: "json",
  },
  {
    id: "json-item",
    label: "Item with :id (path.json)",
    group: "JSON API (/json-api)",
    template: "/json-api/items/:id",
    inputs: [text("id", "42")],
    build: (v) => `/json-api/items/${v.id}`,
    expects: "json",
  },

  // -- App-shaped (loaders / cache / action) --
  {
    id: "app-dashboard",
    label: "Dashboard (3 parallel loaders)",
    group: "App (loaders/cache/action)",
    template: "/app/dashboard/:section",
    inputs: [text("section", "main")],
    build: (v) => `/app/dashboard/${v.section}`,
    expects: "html",
  },
  {
    id: "app-cached",
    label: "cache() segment",
    group: "App (loaders/cache/action)",
    template: "/app/cached/:bucket",
    inputs: [text("bucket", "hot")],
    build: (v) => `/app/cached/${v.bucket}`,
    expects: "html",
    note: "same bucket = hit (stored render), new bucket = miss + store",
  },
  {
    id: "app-feedback",
    label: "Action form page",
    group: "App (loaders/cache/action)",
    template: "/app/feedback",
    inputs: [],
    build: () => "/app/feedback",
    expects: "html",
  },

  // -- 404 / fallback scan --
  {
    id: "miss-under-site",
    label: "404 under /site",
    group: "404 (regex fallback)",
    template: "/site/en/<anything>",
    inputs: [text("suffix", "definitely-not-a-route")],
    build: (v) => `/site/en/${v.suffix}`,
    expects: "miss",
    note: "trie miss -> regex fallback scans the /site entry",
  },
  {
    id: "miss-root",
    label: "404 at root (bot probe)",
    group: "404 (regex fallback)",
    template: "/<anything>.php",
    inputs: [text("name", "wp-login")],
    build: (v) => `/${v.name}.php`,
    expects: "miss",
    note: "fallback skips all prefixed entries via staticPrefix",
  },
];
