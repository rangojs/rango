import { test, expect, type Page } from "@playwright/test";
import { useFixture } from "./fixture";

// Pins the home screen's comprehension surface: the prefix-tree map renders
// one row per route group (driven by src/route-structure.ts), rows link into
// real routes, and the dashboard CTA exists. If a group is added without its
// route-structure entry, the map silently understates the app — the count
// assertion here is the guard.
//
// Direct `vite` commands (not `pnpm dev/preview`) so the suite runs locally
// without tripping the pnpm verifyDepsBeforeRun -> lefthook install hook.

async function expectHomeMap(page: Page, url: (u: string) => string) {
  await page.goto(url("/"));

  await expect(page.getByTestId("home-dashboard-cta")).toBeVisible();

  // One tree row per group in route-structure.ts (10 today: root, site, api,
  // shop, json-api, app, hub, mega, site-admin, dup).
  const tree = page.getByTestId("home-tree");
  await expect(tree.locator(".tree-row")).toHaveCount(10);

  // A group row links into a real route.
  const siteRow = page.getByTestId("tree-site");
  await expect(siteRow).toContainText("/site/:locale");
  const l4Link = siteRow.getByRole("link", { name: "l4 nested" });
  await expect(l4Link).toHaveAttribute("href", "/site/en/l4/1/t0/id1");

  // The linked route actually resolves.
  const res = await page.request.get(url("/site/en/l4/1/t0/id1"));
  expect(res.status()).toBe(200);

  // Both navigation-mode links point at the same target.
  await expect(page.getByTestId("home-doc-link")).toHaveAttribute(
    "href",
    "/site/en/flat/1",
  );
  await expect(page.getByTestId("home-nav-link")).toHaveAttribute(
    "href",
    "/site/en/flat/1",
  );
}

test.describe("home screen map (dev)", () => {
  const f = useFixture({ root: ".", command: "node_modules/.bin/vite dev" });

  test("prefix-tree map renders every group with working links", async ({
    page,
  }) => {
    await expectHomeMap(page, f.url);
  });
});

test.describe("home screen map (production)", () => {
  const f = useFixture({
    root: ".",
    command: "node_modules/.bin/vite preview",
  });

  test("prefix-tree map renders every group with working links", async ({
    page,
  }) => {
    await expectHomeMap(page, f.url);
  });
});
