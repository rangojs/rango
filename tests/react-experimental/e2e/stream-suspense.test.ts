import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, testId, expectNoPageError } from "./helper";

/**
 * Streaming on a cold client navigation with a component-placed <Suspense>
 * (no router loading()), under EXPERIMENTAL React. Mirrors the user's repro:
 * the route handler returns immediately, pushes a Meta handle, and passes a
 * server promise into a <Suspense>; a client component use()s it.
 *
 * Contract: the <Suspense> fallback must appear during the navigation (the
 * route streams), then the resolved content replaces it. The handler delay is
 * 3000ms; the fallback must show well before that on a cold nav.
 */
async function runStreamTest(url: (u?: string) => string, page: Page) {
  using _ = expectNoPageError(page);
  page.on("console", (msg) => {
    const t = msg.text();
    if (t.includes("VT-DIAG")) console.log("BROWSER>", t);
  });
  await page.goto(url("/stream-test"));
  await waitForHydration(page);
  await expect(testId(page, "stream-test-index")).toBeVisible();

  await page.getByRole("link", { name: "Go to stream-test/1" }).click();

  // The route streams: the Suspense fallback must appear before the promise
  // resolves (3000ms).
  await expect(testId(page, "stream-test-fallback")).toBeVisible({
    timeout: 2000,
  });
  await expect(testId(page, "stream-test-content")).toHaveText(
    "Test: resolved 1",
    { timeout: 6000 },
  );
  await expect(testId(page, "stream-test-fallback")).toBeHidden();
}

test.describe("stream-suspense", () => {
  const f = useFixture({ root: ".", mode: "dev" });

  test("component Suspense streams its fallback on cold nav", async ({
    page,
  }) => {
    await runStreamTest(f.url, page);
  });
});

test.describe("stream-suspense (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });

  test("component Suspense streams its fallback on cold nav", async ({
    page,
  }) => {
    await runStreamTest(f.url, page);
  });
});
