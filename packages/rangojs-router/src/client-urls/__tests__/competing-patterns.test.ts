import { describe, expect, it } from "vitest";
import { buildRouteTrie } from "../../router/route-trie-builder.js";
import { tryTrieMatch } from "../../router/trie-matching.js";
import { buildClientUrlsTrie, clientUrls } from "../client-urls.js";
import { competingPatterns } from "../server-projection.js";

function Page(): null {
  return null;
}

const group = clientUrls(({ path }) => [
  path("/", Page, { name: "index" }),
  path("/:slug", Page, { name: "product" }),
  path("/detail/:id", Page, { name: "detail" }),
]);

/**
 * The router's trie over `manifest` (route key -> full pattern, in
 * registration order), the group's own keys under `prefix`, the competing
 * patterns the server ships, and a check that the browser's match with them
 * picks what the router routes the URL to.
 */
function setup(
  manifest: Record<string, string>,
  prefix: string,
  mount: string,
) {
  const router = buildRouteTrie(manifest, {});
  const own = new Set(group.routes.map((route) => `${prefix}.${route.name}`));
  const foreign = competingPatterns(
    router,
    buildClientUrlsTrie(group.routes, mount),
    own,
  ).sort();
  /** The group route the browser presents, or null for a plain navigation. */
  const browser = (pathname: string): string | null => {
    const match = group.match(pathname, mount, foreign);
    const record = group.routes.find((route) => route.id === match?.routeKey);
    return record ? `${prefix}.${record.name}` : null;
  };
  /** The group route the router serves, or null for any other. */
  const server = (pathname: string): string | null => {
    const key = tryTrieMatch(router, pathname)?.routeKey;
    return key && own.has(key) ? key : null;
  };
  return { foreign, browser, server };
}

describe("competingPatterns: the server routes a group's URL space shares", () => {
  it("under /:locale?: root routes at a group route's depth, not the group's own or a deeper one", () => {
    const { foreign } = setup(
      {
        login: "/login",
        $path__about_us: "/about/us",
        "docs.page": "/docs/:page",
        "deep.page": "/a/b/c/d",
        "shop.index": "/:locale?",
        "shop.product": "/:locale?/:slug",
        "shop.detail": "/:locale?/detail/:id",
      },
      "shop",
      "/:locale?",
    );
    expect(foreign).toEqual(["/about/us", "/docs/:page", "/login"]);
  });

  it("under /:locale: a sibling include's /:locale/about", () => {
    const { foreign } = setup(
      {
        home: "/",
        "about.page": "/:locale/about",
        "loc.index": "/:locale",
        "loc.product": "/:locale/:slug",
        "loc.detail": "/:locale/detail/:id",
      },
      "loc",
      "/:locale",
    );
    expect(foreign).toEqual(["/:locale/about"]);
  });

  it("keeps constraints and catch-alls as the router registered them", () => {
    const { foreign } = setup(
      {
        "lang.page": "/:lang(en|de)/:page",
        "files.all": "/files/:path+",
        notFound: "/*",
        "shop.index": "/shop",
        "shop.product": "/shop/:slug",
        "shop.detail": "/shop/detail/:id",
      },
      "shop",
      "/shop",
    );
    expect(foreign).toEqual(["/*", "/:lang(en|de)/:page"]);
  });

  it("a literal mount: a sibling route under the same prefix", () => {
    const { foreign } = setup(
      {
        "cart.page": "/shop/cart",
        "shop.index": "/shop",
        "shop.product": "/shop/:slug",
        "shop.detail": "/shop/detail/:id",
      },
      "shop",
      "/shop",
    );
    expect(foreign).toEqual(["/shop/cart"]);
  });
});

// The browser decides with the router's trie over the group's routes and the
// competing ones: it presents a URL exactly when the router routes it to the
// group, and the same route.
describe("the browser's match with the competing routes agrees with the router", () => {
  const cases: Array<
    [string, Record<string, string>, string, string, string[]]
  > = [
    [
      "/:locale? beside root routes",
      {
        login: "/login",
        $path__about_us: "/about/us",
        "docs.page": "/docs/:page",
        notFound: "/*",
        "shop.index": "/:locale?",
        "shop.product": "/:locale?/:slug",
        "shop.detail": "/:locale?/detail/:id",
      },
      "shop",
      "/:locale?",
      [
        "/",
        "/en",
        "/login",
        "/en/login",
        "/shoe",
        "/en/shoe",
        "/about/us",
        "/en/about/us",
        "/docs/x",
        "/detail",
        "/detail/1",
        "/en/detail/1",
        "/a/b/c/d",
      ],
    ],
    [
      "/:locale beside a sibling include",
      {
        home: "/",
        "about.page": "/:locale/about",
        "loc.index": "/:locale",
        "loc.product": "/:locale/:slug",
        "loc.detail": "/:locale/detail/:id",
      },
      "loc",
      "/:locale",
      ["/", "/en", "/en/about", "/en/shoe", "/en/detail/1", "/en/x/y"],
    ],
  ];
  for (const [label, manifest, prefix, mount, urls] of cases) {
    it(label, () => {
      const { browser, server } = setup(manifest, prefix, mount);
      for (const url of urls) {
        expect(browser(url), url).toBe(server(url));
      }
    });
  }

  it("a root /login under /:locale? is not the group's product, and /en/about under /:locale is not", () => {
    expect(
      setup(
        {
          login: "/login",
          "shop.index": "/:locale?",
          "shop.product": "/:locale?/:slug",
          "shop.detail": "/:locale?/detail/:id",
        },
        "shop",
        "/:locale?",
      ).browser("/login"),
    ).toBeNull();
    expect(
      setup(
        {
          "about.page": "/:locale/about",
          "loc.index": "/:locale",
          "loc.product": "/:locale/:slug",
          "loc.detail": "/:locale/detail/:id",
        },
        "loc",
        "/:locale",
      ).browser("/en/about"),
    ).toBeNull();
  });
});
