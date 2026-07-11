import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration } from "./helper";
import fs from "node:fs";
import path from "node:path";

// Local-only regression test — timing-dependent, not suitable for CI.
// Run manually: TEST_BURST_SAVE=1 npx playwright test e2e/hmr-burst-save.test.ts --project=hmr
const skip = !process.env.TEST_BURST_SAVE;
test.describe("hmr burst save", () => {
  // eslint-disable-next-line playwright/no-skipped-test
  test.skip(() => skip, "Set TEST_BURST_SAVE=1 to run");
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test.setTimeout(120000);

  const originalContents = new Map<string, string>();

  test.afterEach(() => {
    for (const [filePath, content] of originalContents) {
      fs.writeFileSync(filePath, content, "utf-8");
    }
    originalContents.clear();
  });

  function saveOriginal(filePath: string) {
    const fullPath = path.join(f.root, filePath);
    if (!originalContents.has(fullPath)) {
      originalContents.set(fullPath, fs.readFileSync(fullPath, "utf-8"));
    }
    return fullPath;
  }

  async function burstWrite(
    filePath: string,
    count: number,
    intervalMs: number,
  ) {
    const fullPath = saveOriginal(filePath);
    const original = originalContents.get(fullPath)!;

    for (let i = 1; i <= count; i++) {
      const cleaned = original.replace(/\n\/\/ HMR-BURST-.*\n/g, "");
      fs.writeFileSync(
        fullPath,
        cleaned + `\n// HMR-BURST-${i}-${Date.now()}\n`,
        "utf-8",
      );
      if (intervalMs > 0 && i < count) {
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }
  }

  function trackFailures(page: Page) {
    const failures: { url: string; status: number; type: string }[] = [];

    page.on("response", (res) => {
      if (res.status() >= 500) {
        failures.push({
          url: res.url(),
          status: res.status(),
          type: "response",
        });
      }
    });

    page.on("requestfailed", (req) => {
      failures.push({
        url: req.url(),
        status: 0,
        type: `failed: ${req.failure()?.errorText}`,
      });
    });

    return failures;
  }

  test("burst saves on slow route (/slow/1) should not produce 500s", async ({
    page,
  }) => {
    // Navigate to slow route — this has a 5s delay in the handler
    await page.goto(f.url("/slow/1"));
    await waitForHydration(page);
    await expect(page.locator("h1")).toHaveText("Slow Page 1");

    const failures = trackFailures(page);

    // 10 rapid saves to the slow page handler (100ms apart)
    // Each save triggers an rsc:update → fetchPartial() to /slow/1
    // With 5s render time, these pile up and overwhelm workerd
    await burstWrite("src/pages/slow.tsx", 10, 100);

    // Wait for HMR storm to settle — the slow route takes 5s per render,
    // so 10 queued fetches = ~50s of server work without debouncing
    await page.waitForTimeout(15000);

    // Try a fresh navigation — this must work
    const response = await page.goto(f.url("/slow/fast"));
    expect(response?.status()).toBe(200);

    if (failures.length > 0) {
      console.log(`[burst-slow] ${failures.length} failures:`);
      for (const f of failures) {
        console.log(`  [${f.type}] ${f.status} ${f.url.slice(0, 150)}`);
      }
    }

    const errors500 = failures.filter((f) => f.status >= 500);
    expect(
      errors500,
      "Partial RSC requests should not 500 during burst saves on slow route",
    ).toEqual([]);
  });

  test("burst saves on slow route during active request", async ({ page }) => {
    // Navigate to fast page first
    await page.goto(f.url("/slow/fast"));
    await waitForHydration(page);
    await expect(page.locator("h1")).toHaveText("Fast Page");

    const failures = trackFailures(page);

    // Click to navigate to slow/1 (5s render) — request is in-flight
    await page.getByTestId("nav-slow-1").click();

    // While the slow render is in-flight, burst-save the handler
    await page.waitForTimeout(500);
    await burstWrite("src/pages/slow.tsx", 10, 100);

    // Wait for everything to settle
    await page.waitForTimeout(15000);

    // Recovery: full page load must work
    const response = await page.goto(f.url("/"));
    expect(response?.status()).toBe(200);

    if (failures.length > 0) {
      console.log(`[burst-slow-inflight] ${failures.length} failures:`);
      for (const f of failures) {
        console.log(`  [${f.type}] ${f.status} ${f.url.slice(0, 150)}`);
      }
    }

    const errors500 = failures.filter((f) => f.status >= 500);
    expect(
      errors500,
      "Partial RSC requests should not 500 when burst-saving during slow render",
    ).toEqual([]);
  });
});
