import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * Functional coverage for the /refresh view-transition demo. The cross-fade
 * itself is visual (driven by <ViewTransition> + the hook's startTransition);
 * here we pin the underlying behavior: a keyed refresh moves every card sharing
 * the key, and one useRefreshLoaders() call moves every group member.
 */

const calls = (page: Page, id: string) =>
  testId(page, `vt-card-${id}-calls`).textContent();

async function runScenario(page: Page) {
  // Wait for every card to have a value (group cards auto-load on mount) before
  // counting per-action requests.
  for (const id of ["rev-a", "rev-b", "rev-c", "users", "orders", "latency"]) {
    await expect(testId(page, `vt-card-${id}-value`)).toBeVisible();
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

  // Group: one useRefreshLoaders("metrics")() call = one server fetch per
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
