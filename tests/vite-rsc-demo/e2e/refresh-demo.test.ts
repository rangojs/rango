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
  // Wait for every card to have a value first — the group cards auto-load on
  // mount, so we let those requests settle before counting per-action ones.
  for (const id of ["rev-a", "rev-b", "rev-c", "users", "orders", "latency"]) {
    await expect(
      page.locator(`[data-testid="rl-card-${id}-value"]`),
    ).toBeVisible();
  }

  // Count requests to the loader fetch endpoint, so we can prove how many
  // server round-trips each action makes.
  let loaderRequests = 0;
  page.on("request", (req) => {
    if (req.url().includes("_rsc_loader")) loaderRequests++;
  });

  // --- Shared key: a single load() is ONE server call that fans out to all
  // three keyed readers with identical data. ---
  const aValue = page.locator('[data-testid="rl-card-rev-a-value"]');
  const before = Number(await calls(page, "rev-a"));
  expect(Number.isFinite(before)).toBe(true);
  const node = await aValue.elementHandle();

  loaderRequests = 0;
  await page.locator('[data-testid="rl-card-rev-a-refresh"]').click();
  await expect
    .poll(async () => Number(await calls(page, "rev-a")))
    .toBe(before + 1);

  // Exactly ONE network round-trip to the loader endpoint, despite three
  // keyed readers — the shared bucket fans the single result out.
  expect(loaderRequests).toBe(1);

  // All three keyed readers converge on the SAME value + the same call count.
  const v = (await aValue.textContent())!;
  await expect(page.locator('[data-testid="rl-card-rev-b-value"]')).toHaveText(
    v,
  );
  await expect(page.locator('[data-testid="rl-card-rev-c-value"]')).toHaveText(
    v,
  );
  await expect(page.locator('[data-testid="rl-card-rev-b-calls"]')).toHaveText(
    String(before + 1),
  );
  await expect(page.locator('[data-testid="rl-card-rev-c-calls"]')).toHaveText(
    String(before + 1),
  );

  // No fallback flash: the original value node is still connected (text updated
  // in place), and the skeleton never appears.
  const kept = node ? await node.evaluate((el) => el.isConnected) : false;
  expect(kept).toBe(true);
  await expect(
    page.locator('[data-testid="rl-card-rev-a-skeleton"]'),
  ).toHaveCount(0);

  // --- Group: one useRefreshLoaders("metrics")() call = one server fetch PER
  // member (three different loaders), each advancing. ---
  const u0 = await calls(page, "users");
  const o0 = await calls(page, "orders");
  const l0 = await calls(page, "latency");

  loaderRequests = 0;
  await page.locator('[data-testid="rl-group-refresh"]').click();
  await expect.poll(() => calls(page, "users")).not.toBe(u0);
  await expect.poll(() => calls(page, "orders")).not.toBe(o0);
  await expect.poll(() => calls(page, "latency")).not.toBe(l0);

  // Three distinct loaders → three round-trips (no false dedup across loaders).
  expect(loaderRequests).toBe(3);
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
