import { expect, test, type Page } from "@playwright/test";
import { byTestId } from "./load-more-fixture.js";
import { guardHydrationErrors } from "./hydration-guard.js";
import { waitForShellHydration } from "./shell-request.js";

// redirect() from a parallel() slot handler, in every app that renders the
// fixture.
//
// The slot's result goes through handleHandlerResult, as a route or layout
// handler's does, so the Response short-circuits: a document request answers
// 302 with its Location, a Link click lands on the target, and an on-demand
// refresh reports render-failed with that Response while the page stored
// before keeps serving (a redirect is never stored). Before the fix the
// Response was resolved into the segment and rendered: 200 with no Location,
// and a refresh failed with a Flight serialization error.
//
// Fixture (both apps): the `/slot-redirect` include. `/page` declares a
// route-scoped `@aside` slot whose handler returns the redirect, `/stored/:slug`
// is a plain `Prerender(..., { onDemand })` route whose slot redirects only for
// a slug the trigger armed, `/trigger/:slug` runs the refresh
// (`?redirect=1` / `?redirect=0` arm and disarm the slot) and answers it as
// JSON with the Response's status and Location, and `/target` is where a
// followed redirect lands.
const TARGET = "/slot-redirect/target";

export interface SlotRedirectFixture {
  url: (path: string) => string;
}

/** A refresh's answer, flattened by the app's trigger route. */
async function refresh(
  page: Page,
  triggerUrl: string,
): Promise<Record<string, unknown>> {
  return (await (await page.request.get(triggerUrl)).json()) as Record<
    string,
    unknown
  >;
}

export function defineSlotRedirectTests(fixture: SlotRedirectFixture): void {
  test("hard navigation to a route whose slot redirects lands on the target", async ({
    page,
  }) => {
    using _ = guardHydrationErrors(page);

    await page.goto(fixture.url("/slot-redirect/page"));

    await expect(byTestId(page, "sr-target")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${TARGET}$`));
  });

  test("soft navigation (Link click) to a route whose slot redirects lands on the target", async ({
    page,
  }) => {
    using _ = guardHydrationErrors(page);

    await page.goto(fixture.url("/slot-redirect"));
    await waitForShellHydration(page);

    await byTestId(page, "sr-link").click();
    await expect(byTestId(page, "sr-target")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${TARGET}$`));
  });

  test("an on-demand refresh that hits the slot's redirect keeps the stored page", async ({
    page,
  }) => {
    using _ = guardHydrationErrors(page);
    const slug = `slot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const storedUrl = fixture.url(`/slot-redirect/stored/${slug}`);
    const triggerUrl = fixture.url(`/slot-redirect/trigger/${slug}`);

    expect(await refresh(page, triggerUrl)).toMatchObject({
      ok: true,
      status: "rendered",
    });

    const stored = await page.goto(storedUrl);
    expect(stored?.status()).toBe(200);
    await waitForShellHydration(page);
    await expect(byTestId(page, "sr-stored-slug")).toHaveText(slug);
    await expect(byTestId(page, "sr-stored-slot")).toBeVisible();

    await page.request.get(`${triggerUrl}?redirect=1`);
    try {
      expect(await refresh(page, triggerUrl)).toMatchObject({
        ok: false,
        status: "render-failed",
        errorStatus: 302,
        errorLocation: TARGET,
      });

      // The redirect is never stored: the page stored before keeps serving.
      const after = await page.goto(storedUrl);
      expect(after?.status()).toBe(200);
      await expect(byTestId(page, "sr-stored-slug")).toHaveText(slug);
    } finally {
      await page.request.get(`${triggerUrl}?redirect=0`);
    }
  });
}
