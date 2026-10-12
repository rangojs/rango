import { describe, it, expect, vi } from "vitest";

// dispatch() never renders RSC; stub plugin-rsc like dispatch.test.ts.
function pluginRscMock() {
  return {
    createFromReadableStream: vi.fn(),
    renderToReadableStream: vi.fn(),
    loadServerAction: vi.fn(),
    decodeReply: vi.fn(),
    decodeAction: vi.fn(),
    decodeFormState: vi.fn(),
    createTemporaryReferenceSet: vi.fn(),
  };
}
vi.mock("@vitejs/plugin-rsc/rsc/server", pluginRscMock);
vi.mock("@vitejs/plugin-rsc/rsc/client", pluginRscMock);

import { dispatch } from "../../testing/dispatch.js";
import { createRouter } from "../../router.js";
import { urls } from "../../urls/urls-function.js";
import type { UrlPatterns } from "../../urls.js";
import { generateManifestFull } from "../../build/generate-manifest.js";
import { buildPerRouterTrie } from "../../build/route-trie.js";
import { flattenLeafEntries } from "../../build/prefix-tree-utils.js";
import {
  ensureRouterManifest,
  getRouterTrie,
  isRouterTrieAuthoritative,
  registerRouterManifestLoader,
  setRouterManifest,
} from "../../route-map-builder.js";
import { buildRouterTrieFromUrlpatterns } from "../../rsc/manifest-init.js";

// Hidden include-scope names ($prefix_*) are route keys: the trie leaf carries
// the name build discovery gave the route, and find-match looks it up in the
// runtime entry that expanded the include. Both realms must therefore name every
// include identically (#1104). Each fixture serves JSON so dispatch reaches the
// route handler; each request names the page the right handler answers.

function json(page: string) {
  return () => ({ page });
}

interface Fixture {
  name: string;
  build: () => UrlPatterns<any>;
  requests: Array<[url: string, page: string]>;
  /** Exact build keys, pinning the position-path naming. */
  keys: string[];
}

const FIXTURES: Fixture[] = [
  {
    name: "two unnamed levels (#1104)",
    build: () => {
      const signIn = urls(({ path }) => [
        path.json("/login", json("login"), { name: "login" }),
      ]);
      const pub = urls(({ include }) => [include("/", signIn)]);
      return urls(({ path, include }) => [
        path.json("/", json("home"), { name: "home" }),
        include("/", pub),
      ]);
    },
    requests: [
      ["/login", "login"],
      ["/", "home"],
    ],
    keys: ["$prefix_0.$prefix_0.login", "home"],
  },
  {
    name: "unnamed siblings inside an unnamed include",
    build: () => {
      const s1 = urls(({ path }) => [
        path.json("/s1", json("s1"), { name: "page" }),
      ]);
      const s2 = urls(({ path }) => [
        path.json("/s2", json("s2"), { name: "page" }),
      ]);
      const p = urls(({ include }) => [include("/", s1), include("/", s2)]);
      return urls(({ include }) => [include("/", p)]);
    },
    requests: [
      ["/s1", "s1"],
      ["/s2", "s2"],
    ],
    keys: ["$prefix_0.$prefix_0.page", "$prefix_0.$prefix_1.page"],
  },
  {
    // X and Z both name a route "index"; Z sits behind a transparent include.
    // A counter-derived name gave both `$prefix_0.index`: the build manifest
    // kept one, and /z rendered X's handler.
    name: 'unnamed beside a transparent { name: "" } holding an unnamed include',
    build: () => {
      const x = urls(({ path }) => [
        path.json("/x", json("x"), { name: "index" }),
      ]);
      const z = urls(({ path }) => [
        path.json("/z", json("z"), { name: "index" }),
      ]);
      const y = urls(({ include }) => [include("/", z)]);
      return urls(({ include }) => [
        include("/", x),
        include("/", y, { name: "" }),
      ]);
    },
    requests: [
      ["/x", "x"],
      ["/z", "z"],
    ],
    keys: ["$prefix_0.index", "$prefix_1_0.index"],
  },
  {
    name: "unnamed includes under named ones, inside a layout",
    build: () => {
      const inner = urls(({ path }) => [
        path.json("/item", json("item"), { name: "item" }),
      ]);
      const shop = urls(({ include }) => [include("/", inner)]);
      const misc = urls(({ path }) => [
        path.json("/misc", json("misc"), { name: "misc" }),
      ]);
      const outer = urls(({ layout, include }) => [
        layout(
          () => null,
          () => [include("/shop", shop, { name: "shop" })],
        ),
        include("/", misc),
      ]);
      return urls(({ include }) => [include("/", outer)]);
    },
    requests: [
      ["/shop/item", "item"],
      ["/misc", "misc"],
    ],
    keys: ["$prefix_0.$prefix_1.misc", "$prefix_0.shop.$prefix_0.item"],
  },
];

async function buildKeys(patterns: UrlPatterns<any>): Promise<string[]> {
  const manifest = await generateManifestFull(patterns, 0);
  return Object.keys(manifest.routeManifest).sort();
}

/**
 * Keys the runtime registers when every request expands its include chain. The
 * router has no trie, so findMatch runs the lazy-expansion path alone.
 */
async function runtimeKeys(fixture: Fixture): Promise<string[]> {
  const router = createRouter({}).routes(fixture.build()) as any;
  for (const [url] of fixture.requests) {
    expect(await router.findMatch(url)).not.toBeNull();
  }
  return Object.keys(router.routeMap).sort();
}

/** Install the trie the way a production build does: JSON, authoritative. */
async function installProductionTrie(router: any): Promise<void> {
  const manifest = await generateManifestFull(router.urlpatterns, 0, {
    routerId: router.id,
  });
  const trie = buildPerRouterTrie(manifest);
  const precomputedEntries: Array<{
    staticPrefix: string;
    routes: Record<string, string>;
  }> = [];
  flattenLeafEntries(
    manifest.prefixTree,
    manifest.routeManifest,
    precomputedEntries,
  );
  const serialized = JSON.parse(JSON.stringify({ trie, precomputedEntries }));
  setRouterManifest(router.id, manifest.routeManifest);
  registerRouterManifestLoader(router.id, async () => serialized);
  await ensureRouterManifest(router.id);
  expect(isRouterTrieAuthoritative(router.id)).toBe(true);
}

async function expectServed(router: any, fixture: Fixture): Promise<void> {
  for (const [url, page] of fixture.requests) {
    const res = await dispatch(router, { request: url });
    expect(res.status, url).toBe(200);
    expect(await res.json(), url).toEqual({ page });
  }
}

describe("hidden include-scope names are a function of tree position", () => {
  describe.each(FIXTURES)("$name", (fixture) => {
    it("build discovery names each include by its position", async () => {
      expect(await buildKeys(fixture.build())).toEqual(
        [...fixture.keys].sort(),
      );
    });

    it("runtime expansion registers the keys build discovery produced", async () => {
      expect(await runtimeKeys(fixture)).toEqual(
        await buildKeys(fixture.build()),
      );
    });

    it("dispatch serves every route through the dev trie", async () => {
      const router = createRouter({}).routes(fixture.build()) as any;
      await buildRouterTrieFromUrlpatterns(router);
      expect(getRouterTrie(router.id)).toBeDefined();
      await expectServed(router, fixture);
    });

    it("dispatch serves every route through the production trie", async () => {
      const router = createRouter({}).routes(fixture.build()) as any;
      await installProductionTrie(router);
      await expectServed(router, fixture);
    });
  });
});
