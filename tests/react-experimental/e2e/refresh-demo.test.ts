import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * Functional coverage for the /refresh view-transition demo. The cross-fade
 * itself is visual (driven by <ViewTransition> + the hook's startTransition);
 * here we pin the underlying behavior: a keyed refresh moves every card sharing
 * the key (from one fetch), a keyed streaming loader re-streams both its readers
 * from one fetch without flashing the nested skeleton, and one
 * useRefreshLoaders() call moves every group member.
 */

const calls = (page: Page, id: string) =>
  testId(page, `vt-card-${id}-calls`).textContent();

async function runScenario(page: Page) {
  // Wait for every card to have a value (group cards auto-load on mount) before
  // counting per-action requests.
  for (const id of ["rev-a", "rev-b", "rev-c", "users", "orders", "latency"]) {
    await expect(testId(page, `vt-card-${id}-value`)).toBeVisible();
  }
  // Product cards: header is SSR-seeded; the nested `details` promise streams in
  // a beat later. Wait for both to resolve before counting per-action requests.
  for (const id of ["prod-a", "prod-b"]) {
    await expect(testId(page, `vt-product-${id}-price`)).toBeVisible();
    await expect(testId(page, `vt-product-${id}-details`)).toBeVisible();
  }

  let loaderRequests = 0;
  page.on("request", (req) => {
    if (req.url().includes("_rsc_loader")) loaderRequests++;
  });

  // Shared key: three cards read one bucket. A single load() is ONE server call
  // whose result fans out to all three with identical data.
  const before = Number(await calls(page, "rev-a"));
  expect(Number.isFinite(before)).toBe(true);

  loaderRequests = 0;
  await testId(page, "vt-card-rev-a-refresh").click();
  await expect
    .poll(async () => Number(await calls(page, "rev-a")))
    .toBe(before + 1);

  // Exactly ONE network round-trip despite three keyed readers.
  expect(loaderRequests).toBe(1);

  // All three keyed readers converge on the same value + call count.
  const v = (await testId(page, "vt-card-rev-a-value").textContent())!;
  await expect(testId(page, "vt-card-rev-b-value")).toHaveText(v);
  await expect(testId(page, "vt-card-rev-c-value")).toHaveText(v);
  await expect(testId(page, "vt-card-rev-b-calls")).toHaveText(
    String(before + 1),
  );
  await expect(testId(page, "vt-card-rev-c-calls")).toHaveText(
    String(before + 1),
  );

  // Streaming product: a keyed loader whose nested `details` promise streams
  // into a nested Suspense. A load() re-streams BOTH keyed cards from ONE fetch;
  // the detail row cross-fades in place rather than flashing the nested skeleton.
  await expect(testId(page, "vt-product-prod-a-details")).toContainText(
    "in stock",
  );
  const pBefore = Number(
    await testId(page, "vt-product-prod-a-calls").textContent(),
  );
  expect(Number.isFinite(pBefore)).toBe(true);

  loaderRequests = 0;
  await testId(page, "vt-product-prod-a-refresh").click();
  await expect
    .poll(async () =>
      Number(await testId(page, "vt-product-prod-a-calls").textContent()),
    )
    .toBe(pBefore + 1);

  // One fetch streamed the whole payload (header + nested details) for both
  // keyed readers.
  expect(loaderRequests).toBe(1);

  // Both product cards converge on call count, price, and re-streamed details.
  await expect(testId(page, "vt-product-prod-b-calls")).toHaveText(
    String(pBefore + 1),
  );
  const pPrice = (await testId(page, "vt-product-prod-a-price").textContent())!;
  await expect(testId(page, "vt-product-prod-b-price")).toHaveText(pPrice);
  const pDetail = (await testId(
    page,
    "vt-product-prod-a-details",
  ).textContent())!;
  await expect(testId(page, "vt-product-prod-b-details")).toHaveText(pDetail);

  // The nested detail skeleton never reappears during the keyed re-stream.
  await expect(testId(page, "vt-product-prod-a-details-skeleton")).toHaveCount(
    0,
  );

  // Group: one useRefreshLoaders()("metrics") call = one server fetch per
  // member (three distinct loaders).
  const u0 = await calls(page, "users");
  const o0 = await calls(page, "orders");
  const l0 = await calls(page, "latency");

  loaderRequests = 0;
  await testId(page, "vt-group-refresh").click();
  await expect.poll(() => calls(page, "users")).not.toBe(u0);
  await expect.poll(() => calls(page, "orders")).not.toBe(o0);
  await expect.poll(() => calls(page, "latency")).not.toBe(l0);
  expect(loaderRequests).toBe(3);
}

test.describe("refresh demo — keys & groups (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });

  test("keyed and group refresh update their cards", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/refresh"));
    await waitForHydration(page);
    await runScenario(page);
  });
});

test.describe("refresh demo — keys & groups (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });

  test.setTimeout(180000);

  test("keyed and group refresh update their cards", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/refresh"));
    await waitForHydration(page);
    await runScenario(page);
  });
});
