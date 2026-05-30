import { expect, test, type Page } from "@playwright/test";
import { test as devTest, devURL } from "./dev-fixture";
import { useFixture } from "./fixture";
import { expectNoPageError, waitForHydration } from "./helper";

/**
 * Demo coverage for the client refresh-key / refresh-group page (/refresh).
 *
 * Verifies the things the demo is meant to show:
 *  - a keyed refresh moves every card sharing that key, together, from ONE fetch;
 *  - a keyed loader whose payload streams in two parts (header + a nested
 *    `details` promise) re-streams BOTH keyed readers from one fetch, holding the
 *    already-revealed detail row in place (no nested-skeleton flash);
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
  // Product cards: header is SSR-seeded; the nested `details` promise streams in
  // a beat later. Wait for both to fully resolve before counting per-action
  // requests.
  for (const id of ["prod-a", "prod-b"]) {
    await expect(
      page.locator(`[data-testid="rl-product-${id}-price"]`),
    ).toBeVisible();
    await expect(
      page.locator(`[data-testid="rl-product-${id}-details"]`),
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

  // --- Streaming product: a keyed loader whose nested `details` promise
  // streams into a nested Suspense. The detail row resolved on first load; a
  // load() re-streams BOTH keyed cards from ONE fetch, and the already-revealed
  // detail row is held in place (no nested-skeleton flash). ---
  const pDetailA = page.locator('[data-testid="rl-product-prod-a-details"]');
  await expect(pDetailA).toContainText("in stock");
  const pBefore = Number(
    await page.locator('[data-testid="rl-product-prod-a-calls"]').textContent(),
  );
  expect(Number.isFinite(pBefore)).toBe(true);
  const pNode = await pDetailA.elementHandle();

  loaderRequests = 0;
  await page.locator('[data-testid="rl-product-prod-a-refresh"]').click();
  await expect
    .poll(async () =>
      Number(
        await page
          .locator('[data-testid="rl-product-prod-a-calls"]')
          .textContent(),
      ),
    )
    .toBe(pBefore + 1);

  // One fetch streamed the whole payload (header + nested details) for BOTH
  // keyed readers.
  expect(loaderRequests).toBe(1);

  // Both product cards converge on the same call count, price, and re-streamed
  // detail row.
  await expect(
    page.locator('[data-testid="rl-product-prod-b-calls"]'),
  ).toHaveText(String(pBefore + 1));
  const pPrice = (await page
    .locator('[data-testid="rl-product-prod-a-price"]')
    .textContent())!;
  await expect(
    page.locator('[data-testid="rl-product-prod-b-price"]'),
  ).toHaveText(pPrice);
  const pDetailText = (await pDetailA.textContent())!;
  await expect(
    page.locator('[data-testid="rl-product-prod-b-details"]'),
  ).toHaveText(pDetailText);

  // The detail row re-streamed without flashing its nested skeleton: the
  // already-revealed node is kept (swapped in place via startTransition), and
  // the nested skeleton never reappears.
  const pKept = pNode ? await pNode.evaluate((el) => el.isConnected) : false;
  expect(pKept).toBe(true);
  await expect(
    page.locator('[data-testid="rl-product-prod-a-details-skeleton"]'),
  ).toHaveCount(0);

  // --- Group: one useRefreshLoaders()("metrics") call = one server fetch PER
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

/**
 * Products table (paginated load-more) + cart (server-action write, refresh-
 * primitive re-render). Proves:
 *  - the first page is SSR-seeded and each "Load more" appends one page from ONE
 *    fetch, accumulating rows;
 *  - "Add to cart" is a server action, and the cart count re-renders via a
 *    single keyed refresh that fans out to BOTH cart badges (one fetch), not via
 *    the action's return value.
 */
async function runProductsCartScenario(page: Page) {
  const rows = page.locator('[data-testid^="pc-row-"]');
  const headerCount = page.locator('[data-testid="pc-badge-header-count"]');
  const sidebarCount = page.locator('[data-testid="pc-badge-sidebar-count"]');

  // SSR-seeded first page: exactly PAGE_SIZE (3) rows; both badges start at 0.
  await expect(rows).toHaveCount(3);
  await expect(headerCount).toHaveText("0");
  await expect(sidebarCount).toHaveText("0");

  let loaderRequests = 0;
  page.on("request", (req) => {
    if (req.url().includes("_rsc_loader")) loaderRequests++;
  });

  // Load more: ONE fetch appends the next page.
  loaderRequests = 0;
  await page.locator('[data-testid="pc-load-more"]').click();
  await expect(rows).toHaveCount(6);
  expect(loaderRequests).toBe(1);

  // Load more again: the final page; the button is replaced by the done note.
  loaderRequests = 0;
  await page.locator('[data-testid="pc-load-more"]').click();
  await expect(rows).toHaveCount(9);
  expect(loaderRequests).toBe(1);
  await expect(page.locator('[data-testid="pc-load-more"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="pc-load-more-done"]')).toBeVisible();

  // Add to cart: the action mutates server state, then ONE keyed cart refresh
  // re-reads CartLoader and fans the new count out to BOTH badges. The action
  // POST is not a _rsc_loader request, so exactly one loader round-trip lands.
  loaderRequests = 0;
  await page.locator('[data-testid="pc-add-widget"]').click();
  await expect(headerCount).toHaveText("1");
  await expect(sidebarCount).toHaveText("1");
  expect(loaderRequests).toBe(1);

  // A second add advances both badges together again, still one fetch.
  loaderRequests = 0;
  await page.locator('[data-testid="pc-add-gizmo"]').click();
  await expect(headerCount).toHaveText("2");
  await expect(sidebarCount).toHaveText("2");
  expect(loaderRequests).toBe(1);
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

  devTest(
    "products table load-more and cart re-render via refresh primitive",
    async ({ page, devServerURL }) => {
      using _ = expectNoPageError(page);
      await page.goto(devURL(devServerURL, "/refresh"));
      await waitForHydration(page);
      await runProductsCartScenario(page);
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

  test("products table load-more and cart re-render via refresh primitive", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/refresh"));
    await waitForHydration(page);
    await runProductsCartScenario(page);
  });
});
