import { test, expect, type Page } from "@playwright/test";
import { useFixture } from "./fixture";

// Pins the /dashboard benchmark tool: route-class picker builds real paths,
// the fetch runner produces a stats row, and unexpected statuses are surfaced
// (the 404 class reports ok because 404 IS its expected status).
//
// Direct `vite` commands (not `pnpm dev/preview`) so the suite runs locally
// without tripping the pnpm verifyDepsBeforeRun -> lefthook install hook.

async function expectDashboardRuns(page: Page, url: (u: string) => string) {
  await page.goto(url("/dashboard"));
  // Wait for the ISLAND's own hydration marker. The router-level
  // data-hydrated signal is not enough: this client island's chunk can still
  // be loading after the root hydrates (verified — waitForHydration alone
  // left the runs selector unhydrated in dev).
  await page.getByTestId("dash-ready").waitFor({ state: "attached" });

  // Default class: run 5x fetch and expect a result row with a numeric median.
  await page.getByTestId("dash-n").selectOption("5");
  await page.getByTestId("dash-run").click();
  const row = page.getByTestId("dash-result-row").first();
  await expect(row).toBeVisible();
  await expect(row.getByTestId("dash-median")).toContainText(/\d+(\.\d+)?ms/);
  await expect(row.locator(".chip.ok")).toContainText("200 ok");

  // Param inputs build the path: switch to a param class and check the target.
  await page.getByTestId("dash-class").selectOption("site-l4");
  await expect(page.getByTestId("dash-path")).toContainText(
    "/site/en/l4/1/t0/id1",
  );

  // 404 class: expected status is 404, so the run reports ok.
  await page.getByTestId("dash-class").selectOption("miss-root");
  await page.getByTestId("dash-run").click();
  const missRow = page.getByTestId("dash-result-row").first();
  await expect(missRow.locator(".chip.ok")).toContainText("404 ok");
}

test.describe("benchmark dashboard (dev)", () => {
  const f = useFixture({ root: ".", command: "node_modules/.bin/vite dev" });

  test("runs fetch benchmarks per route class", async ({ page }) => {
    await expectDashboardRuns(page, f.url);
  });
});

test.describe("benchmark dashboard (production)", () => {
  const f = useFixture({
    root: ".",
    command: "node_modules/.bin/vite preview",
  });

  test("runs fetch benchmarks per route class", async ({ page }) => {
    await expectDashboardRuns(page, f.url);
  });
});
