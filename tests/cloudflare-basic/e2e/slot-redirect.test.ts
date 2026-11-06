import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  testId,
  clickAndWaitFor,
} from "./helper";

/**
 * Workerd twin of packages/rangojs-router/e2e/slot-redirect.test.ts: a parallel
 * slot handler's returned redirect() short-circuits the request like a route or
 * layout handler's — a document request lands on the target, a client
 * navigation does too, and an on-demand refresh reports the redirect while the
 * page stored before keeps serving. Pins the fix on the Cloudflare runtime, not
 * just the node dev server.
 *
 * Why it happens: the slot handler's result reached the segment walk raw
 * (resolveParallelSlotComponent, segment-resolution/revalidation.ts), so the
 * Response became the slot's component and only surfaced during Flight
 * serialization. Fixture: src/pages/slot-redirect.tsx.
 */
function defineSpec(label: string, mode: "dev" | "build") {
  test.describe(`slot redirect (${label})`, () => {
    const f = useFixture({ root: ".", mode });

    // The flag lives in the app's KV, which outlives a run: a suite that stopped
    // mid-way (a red run, an aborted one) leaves it set, and every page under
    // the slot's layout would redirect.
    const slotRenders = (page: Page) =>
      page.request.get(f.url("/slot-redirect/od-trigger?slot=0"));

    test("hard navigation to a slot's redirect lands on the target", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/slot-redirect/redirect"));
      await waitForHydration(page);

      await expect(page).toHaveURL(/\/slot-redirect\/target$/);
      await expect(testId(page, "cf-sr-target")).toBeVisible();
    });

    test("soft navigation (Link click) to a slot's redirect lands on the target", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/slot-redirect/"));
      await waitForHydration(page);
      await expect(testId(page, "cf-sr-index")).toBeVisible();

      await clickAndWaitFor(
        testId(page, "cf-sr-link-redirect"),
        testId(page, "cf-sr-target"),
      );
      await expect(page).toHaveURL(/\/slot-redirect\/target$/);
    });

    test("the slot renders normally on a page that does not redirect", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await slotRenders(page);
      await page.goto(f.url("/slot-redirect/plain"));
      await waitForHydration(page);

      await expect(testId(page, "cf-sr-aside")).toHaveText("aside body");
      await expect(testId(page, "cf-sr-plain")).toBeVisible();
    });

    test("on-demand refresh: the redirect is reported and the stored page keeps serving", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Store the page.
      await slotRenders(page);
      const first = await page.request.get(f.url("/slot-redirect/od-trigger"));
      expect(await first.json()).toMatchObject({
        ok: true,
        status: "rendered",
      });

      await page.goto(f.url("/slot-redirect/od"));
      await waitForHydration(page);
      const stored = await testId(page, "cf-sr-od-stamp").textContent();

      // The slot starts redirecting: a refresh meets the redirect.
      await page.request.get(f.url("/slot-redirect/od-trigger?slot=1"));
      const refreshed = await page.request.get(
        f.url("/slot-redirect/od-trigger"),
      );
      expect(await refreshed.json()).toMatchObject({
        ok: false,
        status: "render-failed",
        // The redirect itself, not a Flight serialization error.
        error: { response: 302, location: "/slot-redirect/target" },
      });

      // Nothing was stored in its place: the page stored before keeps serving.
      await page.goto(f.url("/slot-redirect/od"));
      await waitForHydration(page);
      await expect(testId(page, "cf-sr-od-stamp")).toHaveText(stored);

      // Back to a slot that renders, for the rest of the suite.
      await slotRenders(page);
    });
  });
}

defineSpec("dev", "dev");
defineSpec("production", "build");
