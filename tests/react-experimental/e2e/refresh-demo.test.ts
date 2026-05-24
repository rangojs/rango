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
  // Shared key: both Revenue cards seed from one bucket.
  await expect(testId(page, "vt-card-rev-a-value")).toBeVisible();
  await expect(testId(page, "vt-card-rev-b-value")).toBeVisible();
  const a0 = await calls(page, "rev-a");

  await testId(page, "vt-card-rev-a-refresh").click();
  await expect.poll(() => calls(page, "rev-a")).not.toBe(a0);
  const a1 = (await calls(page, "rev-a"))!;
  // The keyless sibling moved with it (same shared bucket).
  await expect(testId(page, "vt-card-rev-b-calls")).toHaveText(a1);
  await expect(testId(page, "vt-card-rev-b-value")).toHaveText(
    (await testId(page, "vt-card-rev-a-value").textContent())!,
  );

  // Group: one useRefreshLoaders("metrics")() call moves all three.
  await expect(testId(page, "vt-card-users-value")).toBeVisible();
  await expect(testId(page, "vt-card-orders-value")).toBeVisible();
  await expect(testId(page, "vt-card-latency-value")).toBeVisible();
  const u0 = await calls(page, "users");
  const o0 = await calls(page, "orders");
  const l0 = await calls(page, "latency");

  await testId(page, "vt-group-refresh").click();

  await expect.poll(() => calls(page, "users")).not.toBe(u0);
  await expect.poll(() => calls(page, "orders")).not.toBe(o0);
  await expect.poll(() => calls(page, "latency")).not.toBe(l0);
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
