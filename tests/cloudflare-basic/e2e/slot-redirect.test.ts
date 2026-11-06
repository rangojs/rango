import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  testId,
  clickAndWaitFor,
} from "./helper";

// redirect() from a parallel slot handler (src/pages/slot-redirect.tsx)
// redirects as a route or layout handler's does: returned from a layout's slot
// or from the route's own slot, or thrown, on the document and on a client
// navigation. An on-demand refresh whose slot redirects is render-failed and
// the page stored before (the KV overlay) keeps serving.
function defineTests(f: Fixture) {
  const cases = [
    ["a layout's slot", "/slot-redirect/layout-slot", "sr-link-layout"],
    ["the route's own slot", "/slot-redirect/route-slot", "sr-link-route"],
    ["a thrown redirect", "/slot-redirect/thrown", "sr-link-thrown"],
  ] as const;

  for (const [name, path, link] of cases) {
    test(`document: ${name} answers a 302 to the target`, async ({ page }) => {
      const response = await page.request.get(f.url(path), {
        maxRedirects: 0,
      });
      expect(response.status()).toBe(302);
      expect(response.headers()["location"]).toBe("/slot-redirect/target");
    });

    test(`document: ${name} lands on the target`, async ({ page }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url(path));
      await waitForHydration(page);
      await expect(testId(page, "sr-target")).toBeVisible();
      await expect(page).toHaveURL(/\/slot-redirect\/target$/);
    });

    test(`navigation: ${name} lands on the target`, async ({ page }) => {
      using _ = expectNoPageError(page);
      await page.goto(f.url("/slot-redirect/"));
      await waitForHydration(page);
      await clickAndWaitFor(testId(page, link), testId(page, "sr-target"));
      await expect(page).toHaveURL(/\/slot-redirect\/target$/);
    });
  }

  test("on-demand refresh: a slot that redirects is render-failed, and the stored page keeps serving", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    const slug = `sr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const trigger = (qs = "") =>
      page.request
        .get(f.url(`/slot-redirect/trigger/${slug}${qs}`))
        .then((r) => r.json());
    const stamp = async (): Promise<string | null> => {
      await page.goto(f.url(`/slot-redirect/on-demand/${slug}`));
      await waitForHydration(page);
      await expect(testId(page, "sr-od-aside")).toBeVisible();
      return testId(page, "sr-od-stamp").textContent();
    };

    expect(await trigger()).toMatchObject({ ok: true, status: "rendered" });
    const stored = await stamp();

    await trigger("?redirect=1");
    try {
      expect(await trigger()).toMatchObject({
        ok: false,
        status: "render-failed",
        error: { status: 302, location: "/slot-redirect/target" },
      });
      // Served from the overlay: the slot does not run, so nothing redirects.
      expect(await stamp()).toBe(stored);
      await expect(page).toHaveURL(new RegExp(`/on-demand/${slug}$`));
    } finally {
      await trigger("?redirect=0");
    }

    expect(await trigger()).toMatchObject({ ok: true, status: "rendered" });
    expect(await stamp()).not.toBe(stored);
  });
}

test.describe("slot redirect (dev)", () => {
  defineTests(useFixture({ root: ".", mode: "dev" }));
});

test.describe("slot redirect (production)", () => {
  defineTests(useFixture({ root: ".", mode: "build" }));
});
