import { expect, test, type Page } from "@playwright/test";
import { test as devTest, devURL } from "./dev-fixture";
import { waitForHydration, prodDescribe } from "./helper";

/**
 * Loader handle writes on clientUrls routes (/client-shop).
 *
 * Loaders write meta and breadcrumbs from their bodies —
 * `ctx.use(Meta)({ title })`, handler-parity push. Delivery is ASYNC by the
 * race model: pushes that beat the handler barrier ride the SSR handle
 * snapshot; later ones stream and apply client-side — post-hydration via
 * metadata.handlesLate on document loads, progressively via the (now
 * fullySettled-scoped) handles generator on navigations. The product loader's
 * pushes land after a 2s cached fetch cold / instantly warm, so these tests
 * only pin the CONVERGED state, not which channel delivered it.
 */

async function expectCrumbs(page: Page, labels: string[]) {
  // The last crumb renders as a <span> (current page), earlier ones as links,
  // with a "/" separator inside each non-first <li> — normalize the li text.
  await expect
    .poll(
      async () => {
        const items = await page
          .locator('nav[aria-label="Breadcrumb"] li')
          .allTextContents();
        return items.map((t) => t.replace(/^\s*\/\s*/, "").trim());
      },
      { timeout: 15000 },
    )
    .toEqual(labels);
}

devTest.describe("client-shop loader handle writes", () => {
  devTest(
    "document load applies loader-written title and breadcrumbs",
    async ({ page, devServerURL }) => {
      await page.goto(
        devURL(devServerURL, "/client-shop/product/wireless-mouse"),
      );
      await waitForHydration(page);
      await expect
        .poll(() => page.title(), { timeout: 20000 })
        .toBe("Wireless Mouse — Client Shop");
      await expectCrumbs(page, ["Client Shop", "Wireless Mouse"]);
    },
  );

  devTest(
    "navigation updates title and breadcrumbs from the new route's loaders",
    async ({ page, devServerURL }) => {
      await page.goto(devURL(devServerURL, "/client-shop"));
      await waitForHydration(page);
      await expect
        .poll(() => page.title(), { timeout: 20000 })
        .toBe("All products — Client Shop");

      await page.click('[data-testid="client-shop-card-laptop-stand"]');
      await expect
        .poll(() => page.title(), { timeout: 20000 })
        .toBe("Laptop Stand — Client Shop");
      await expectCrumbs(page, ["Client Shop", "Laptop Stand"]);
    },
  );
});

prodDescribe("client-shop loader handle writes", (f) => {
  test("document load applies loader-written title and breadcrumbs", async ({
    page,
  }) => {
    await page.goto(f.url("/client-shop/product/wireless-mouse"));
    await waitForHydration(page);
    await expect
      .poll(() => page.title(), { timeout: 20000 })
      .toBe("Wireless Mouse — Client Shop");
    await expectCrumbs(page, ["Client Shop", "Wireless Mouse"]);
  });

  test("navigation updates title and breadcrumbs from the new route's loaders", async ({
    page,
  }) => {
    await page.goto(f.url("/client-shop"));
    await waitForHydration(page);
    await expect
      .poll(() => page.title(), { timeout: 20000 })
      .toBe("All products — Client Shop");

    await page.click('[data-testid="client-shop-card-laptop-stand"]');
    await expect
      .poll(() => page.title(), { timeout: 20000 })
      .toBe("Laptop Stand — Client Shop");
    await expectCrumbs(page, ["Client Shop", "Laptop Stand"]);
  });
});
