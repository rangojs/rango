import { expect, test, type Page } from "@playwright/test";
import { test as devTest, devURL } from "./dev-fixture";
import { useFixture } from "./fixture";
import { expectNoPageError, waitForHydration } from "./helper";

/**
 * Demo coverage for the client refresh-key / refresh-group page (/refresh).
 *
 * Verifies the three things the demo is meant to show:
 *  - a keyed refresh moves every card sharing that key, together;
 *  - one useRefreshLoaders() call refreshes every member of the group;
 *  - a refresh does NOT flash the Suspense fallback — the rendered value node is
 *    kept (the hook commits new data in startTransition), so it is reconciled in
 *    place rather than remounted behind the skeleton.
 */

const calls = (page: Page, id: string) =>
  page.locator(`[data-testid="rl-card-${id}-calls"]`).textContent();

async function runScenario(page: Page) {
  // --- Shared key: both Revenue cards seed from one bucket, equal. ---
  const aValue = page.locator('[data-testid="rl-card-rev-a-value"]');
  const bValue = page.locator('[data-testid="rl-card-rev-b-value"]');
  await expect(aValue).toBeVisible();
  await expect(bValue).toBeVisible();
  const aCalls0 = await calls(page, "rev-a");

  // Capture the live value node so we can prove it survives the refresh.
  const node = await aValue.elementHandle();

  await page.locator('[data-testid="rl-card-rev-a-refresh"]').click();

  // The refresh ran (loader calls advanced)...
  await expect.poll(() => calls(page, "rev-a")).not.toBe(aCalls0);
  const aCalls1 = (await calls(page, "rev-a"))!;
  // ...and the keyless sibling moved with it (same shared bucket).
  await expect(bValue).toHaveText(await aValue.textContent());
  await expect(page.locator('[data-testid="rl-card-rev-b-calls"]')).toHaveText(
    aCalls1,
  );

  // No fallback flash: the original value node is still connected (text updated
  // in place), and the skeleton never appears.
  const kept = node ? await node.evaluate((el) => el.isConnected) : false;
  expect(kept).toBe(true);
  await expect(
    page.locator('[data-testid="rl-card-rev-a-skeleton"]'),
  ).toHaveCount(0);

  // --- Group: one useRefreshLoaders("metrics")() call refreshes all three. ---
  await expect(
    page.locator('[data-testid="rl-card-users-value"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="rl-card-orders-value"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="rl-card-latency-value"]'),
  ).toBeVisible();

  const u0 = await calls(page, "users");
  const o0 = await calls(page, "orders");
  const l0 = await calls(page, "latency");

  await page.locator('[data-testid="rl-group-refresh"]').click();

  await expect.poll(() => calls(page, "users")).not.toBe(u0);
  await expect.poll(() => calls(page, "orders")).not.toBe(o0);
  await expect.poll(() => calls(page, "latency")).not.toBe(l0);
}

devTest.describe("refresh-demo", () => {
  devTest(
    "keys and groups refresh without flashing the fallback",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);
      await page.goto(devURL(devServerURL, "/refresh"));
      await waitForHydration(page);
      await runScenario(page);
    },
  );
});

test.describe("refresh-demo (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });

  test.setTimeout(120000);

  test("keys and groups refresh without flashing the fallback", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/refresh"));
    await waitForHydration(page);
    await runScenario(page);
  });
});
