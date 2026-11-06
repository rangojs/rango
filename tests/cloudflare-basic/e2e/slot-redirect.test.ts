import { expect, test, type APIResponse } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  testId,
  clickAndWaitFor,
} from "./helper";

// redirect() from a parallel() slot handler.
//
// The slot's result goes through handleHandlerResult, as a route or layout
// handler's does, so the Response short-circuits: the document request answers
// 302 with its Location, a Link click lands on the target, and an on-demand
// refresh reports render-failed with that Response while the page stored before
// keeps serving (a redirect is never stored). Before the fix the Response was
// resolved into the segment and rendered: 200 with no Location, and a refresh
// failed with a Flight serialization error.
const TARGET = "/slot-redirect/target";

/** A refresh's answer, flattened by the app's trigger route. */
async function refresh(res: APIResponse): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function slotRedirectSuite(f: Fixture) {
  test("hard navigation to a route whose slot redirects lands on the target", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/slot-redirect/page"));

    await expect(testId(page, "sr-target")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${TARGET}$`));
  });

  test("soft navigation (Link click) to a route whose slot redirects lands on the target", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/slot-redirect"));
    await waitForHydration(page);

    await clickAndWaitFor(testId(page, "sr-link"), testId(page, "sr-target"));
    await expect(page).toHaveURL(new RegExp(`${TARGET}$`));
  });

  test("an on-demand refresh that hits the slot's redirect keeps the stored page", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    const slug = `slot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const storedUrl = f.url(`/slot-redirect/stored/${slug}`);
    const triggerUrl = f.url(`/slot-redirect/trigger/${slug}`);

    expect(await refresh(await page.request.get(triggerUrl))).toMatchObject({
      ok: true,
      status: "rendered",
    });

    const stored = await page.goto(storedUrl);
    expect(stored?.status()).toBe(200);
    await waitForHydration(page);
    await expect(testId(page, "sr-stored-slug")).toHaveText(slug);
    await expect(testId(page, "sr-stored-slot")).toBeVisible();

    await page.request.get(`${triggerUrl}?redirect=1`);
    try {
      expect(await refresh(await page.request.get(triggerUrl))).toMatchObject({
        ok: false,
        status: "render-failed",
        errorStatus: 302,
        errorLocation: TARGET,
      });

      // The redirect is never stored: the page stored before keeps serving.
      const after = await page.goto(storedUrl);
      expect(after?.status()).toBe(200);
      await expect(testId(page, "sr-stored-slug")).toHaveText(slug);
    } finally {
      await page.request.get(`${triggerUrl}?redirect=0`);
    }
  });
}

test.describe("parallel slot redirect", () => {
  slotRedirectSuite(useFixture({ root: ".", mode: "dev" }));
});

test.describe("parallel slot redirect (production)", () => {
  slotRedirectSuite(useFixture({ root: ".", mode: "build" }));
});
