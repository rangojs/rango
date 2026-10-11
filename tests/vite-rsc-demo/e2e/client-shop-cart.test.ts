import { expect, test, type Page } from "@playwright/test";
import { test as devTest, devURL } from "./dev-fixture";
import { waitForHydration, prodDescribe } from "./helper";

/**
 * Add-to-cart on a /client-shop product page: one action, per-loader
 * decisions the server makes on the action request. The cart loader's
 * revalidate() matches the shop actions namespace, so the badge refreshes;
 * the product loaders' imported predicate (src/urls/client-shop.predicates.ts)
 * holds on any action, so the product stays on screen.
 */
async function runAddToCartSpec(page: Page, url: (path: string) => string) {
  await page.goto(url("/client-shop/product/wireless-headphones"));
  await waitForHydration(page);
  await expect(page.locator('[data-testid="client-shop-name"]')).toHaveText(
    "Wireless Headphones",
    { timeout: 15000 },
  );
  await expect(page.locator('[data-testid="client-shop-related"]')).toBeVisible(
    { timeout: 15000 },
  );

  const badge = page.locator('[data-testid="client-shop-cart-count"]');
  const readCount = async (): Promise<number> =>
    Number((await badge.textContent())?.match(/\((\d+)\)/)?.[1]);
  const before = await readCount();
  expect(Number.isNaN(before)).toBe(false);

  await page.getByRole("button", { name: "Add to Cart", exact: true }).click();
  await expect.poll(readCount, { timeout: 15000 }).toBeGreaterThan(before);
  await expect(page.locator('[data-testid="client-shop-name"]')).toHaveText(
    "Wireless Headphones",
  );
  await expect(
    page.locator('[data-testid="client-shop-related"]'),
  ).toBeVisible();
}

devTest.describe("client-shop add-to-cart", () => {
  devTest(
    "an action refreshes the cart badge and holds the product",
    async ({ page, devServerURL }) => {
      await runAddToCartSpec(page, (path) => devURL(devServerURL, path));
    },
  );
});

prodDescribe("client-shop add-to-cart", (f) => {
  test("an action refreshes the cart badge and holds the product", async ({
    page,
  }) => {
    await runAddToCartSpec(page, f.url);
  });
});
