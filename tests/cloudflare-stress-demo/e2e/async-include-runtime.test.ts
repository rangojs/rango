import { test, expect, type APIRequestContext } from "@playwright/test";
import { useFixture } from "./fixture";

// Runtime coverage for async include(prefix, () => import("./routes")). The
// sibling reverse.test.ts / named-routes.test.ts only prove the reverse MAP and
// gen FILE carry the split-group names — both are populated from build-time
// discovery and resolve even if runtime matching 404s (exactly the dropped-
// Promise failure in router.ts that this exercises). These tests actually
// REQUEST the routes so the router's findMatch has to await each provider's
// import and, for /shop, splice its nested product/category entries.
//
// Direct `vite` commands (not `pnpm dev/preview`) so the suite runs locally
// without tripping the pnpm verifyDepsBeforeRun -> lefthook install hook.
//
// Bucketing: the build-server describe is titled "(production)" so it lands in
// the production grep; the dev describe must not contain that tag.

async function expectAsyncIncludeRoutes(
  request: APIRequestContext,
  url: (u: string) => string,
) {
  // Leaf async includes (each its own code-split chunk), JSON response routes.
  const jsonApi = await request.get(url("/json-api/health"));
  expect(jsonApi.status()).toBe(200);
  expect((await jsonApi.json()).status).toBe("ok");

  const api = await request.get(url("/api/bench/first"));
  expect(api.status()).toBe(200);
  expect((await api.json()).route).toBe("/api/bench/first");

  // Leaf async include carrying a path param (/site/:locale/...).
  const site = await request.get(url("/site/en/bench/first"));
  expect(site.status()).toBe(200);
  const siteBody = await site.json();
  expect(siteBody.route).toBe("/site/en/bench/first");
  expect(siteBody.params.locale).toBe("en");

  // NESTED async include: the shop module is imported on first hit, THEN its
  // product/category children are spliced. /shop is the module's own route;
  // /shop/product/* and /shop/category/* are its nested includes.
  const shop = await request.get(url("/shop"));
  expect(shop.status()).toBe(200);
  expect((await shop.json()).route).toBe("/shop");

  const product = await request.get(url("/shop/product/bench/first"));
  expect(product.status()).toBe(200);
  expect((await product.json()).route).toBe("/shop/product/bench/first");

  const category = await request.get(url("/shop/category/bench/first"));
  expect(category.status()).toBe(200);
  expect((await category.json()).route).toBe("/shop/category/bench/first");

  // HUB: /g's module declares 50 nested async includes; hitting one child
  // imports the hub chunk, splices 50 entries, then imports only that child.
  const hubChild = await request.get(url("/g/g007/bench/first"));
  expect(hubChild.status()).toBe(200);
  expect((await hubChild.json()).route).toBe("/g/g007/bench/first");

  // Named catch-alls inside a generated group: :rest+ requires a remainder,
  // :rest* binds "" on the bare prefix.
  const treeDeep = await request.get(url("/g/g001/tree/a/b/c"));
  expect(treeDeep.status()).toBe(200);
  const treeBare = await request.get(url("/g/g001/tree"));
  expect(treeBare.status()).toBe(404);
  const blobBare = await request.get(url("/g/g001/blob"));
  expect(blobBare.status()).toBe(200);

  // Suffix params: longest literal suffix wins — app.min.js resolves to the
  // .min.js route (file: "app"), never .js (file: "app.min"). The params are
  // SSR'd inside a <pre>, so quotes arrive HTML-escaped.
  const minJs = await request.get(url("/g/g001/files/app.min.js"), {
    headers: { accept: "text/html" },
  });
  expect(minJs.status()).toBe(200);
  expect(await minJs.text()).toContain("&quot;file&quot;:&quot;app&quot;");

  // 3-level ASYNC include chain: deepest first hit awaits three imports.
  const mega = await request.get(url("/mega/l2/l3/p1/x"));
  expect(mega.status()).toBe(200);
  expect((await mega.json()).level).toBe(3);

  // String-prefix overlap: /site-admin must not be captured by /site.
  const admin = await request.get(url("/site-admin/p1"));
  expect(admin.status()).toBe(200);
  expect((await admin.json()).group).toBe("site-admin");

  // Same-staticPrefix pair: both /dup/:cat and /dup/:brand siblings resolve
  // (the router imports both chunks on the first /dup hit).
  const dupCat = await request.get(url("/dup/shoes/cat-page1"));
  expect(dupCat.status()).toBe(200);
  expect((await dupCat.json()).group).toBe("dup-cat");
  const dupBrand = await request.get(url("/dup/acme/brand-page1"));
  expect(dupBrand.status()).toBe(200);
  expect((await dupBrand.json()).group).toBe("dup-brand");
}

test.describe("async include routes (dev)", () => {
  const f = useFixture({ root: ".", command: "node_modules/.bin/vite dev" });

  test("resolves leaf and nested async includes at runtime", async ({
    request,
  }) => {
    await expectAsyncIncludeRoutes(request, f.url);
  });

  test("renders a nested async-include component route", async ({ page }) => {
    await page.goto(f.url("/shop/product/1"));
    await expect(page.getByRole("heading", { name: /Product/ })).toBeVisible();
  });
});

test.describe("async include routes (production)", () => {
  const f = useFixture({
    root: ".",
    command: "node_modules/.bin/vite preview",
  });

  test("resolves leaf and nested async includes at runtime", async ({
    request,
  }) => {
    await expectAsyncIncludeRoutes(request, f.url);
  });

  test("renders a nested async-include component route", async ({ page }) => {
    await page.goto(f.url("/shop/product/1"));
    await expect(page.getByRole("heading", { name: /Product/ })).toBeVisible();
  });
});
