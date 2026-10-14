import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
import { waitForHydration, testId } from "./helper";

/**
 * A click that adopts a still-streaming prefetch owns its stream: the
 * prefetch's 30 s stall timer (browser/prefetch/fetch.ts) must not abort the
 * response the page reads. /prefetch-stall streams its slow part 8 s after
 * the request; the browser clock jumps past the stall timeout while that part
 * is pending.
 */
function runSpec(f: Fixture): void {
  test("a click that adopted a streaming prefetch keeps its stream past the stall timeout", async ({
    page,
  }) => {
    await page.clock.install();
    const isStallRequest = (url: string) => {
      const u = new URL(url);
      return (
        u.pathname === "/prefetch-stall" && u.searchParams.has("_rsc_partial")
      );
    };
    let requests = 0;
    page.on("request", (r) => {
      if (isStallRequest(r.url())) requests++;
    });

    await page.goto(f.url("/prefetch-stall-from"));
    await waitForHydration(page);

    const prefetched = page.waitForResponse((r) => isStallRequest(r.url()));
    await testId(page, "stall-link").hover();
    await prefetched;
    await testId(page, "stall-link").click();
    await expect(testId(page, "stall-shell")).toBeVisible();
    await expect(testId(page, "stall-pending")).toBeVisible();

    await page.clock.fastForward(31_000);
    await expect(testId(page, "stall-done")).toBeVisible({ timeout: 20_000 });
    // The click read the prefetch's response, not one of its own.
    expect(requests).toBe(1);
  });
}

test.describe("prefetch-stall-adopted (dev)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  runSpec(f);
});

test.describe("prefetch-stall-adopted (production)", () => {
  test.setTimeout(120000);
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  runSpec(f);
});
