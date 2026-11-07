import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { waitForShellHydration } from "./shell-request.js";

/**
 * An intercept or parallel slot handler's redirect() takes the visitor where
 * a route handler's would: to /slot-redirect/done. The handlers redirect once
 * the `sr-armed` cookie is set, by the Arm button's server action or by the
 * test. An action's revalidation awaits a handler under loading(), so its
 * redirect is the action's answer; a slot handler's returned redirect answers
 * a document request, a client navigation and a refresh. Fixture:
 * slot-redirect.tsx in each app, mounted at /slot-redirect; both apps call
 * this from a dev and a (production) describe.
 */

export interface SlotRedirectScenarioOptions {
  url: (pathname: string) => string;
}

const DONE = "/slot-redirect/done";

export function runSlotRedirectTests(
  options: SlotRedirectScenarioOptions,
): void {
  async function arm(context: BrowserContext): Promise<void> {
    await context.addCookies([
      { name: "sr-armed", value: "1", url: options.url("/") },
    ]);
  }

  async function show(page: Page, pathname: string, testId: string) {
    await page.goto(options.url(pathname));
    await waitForShellHydration(page);
    await expect(page.getByTestId(testId)).toBeVisible();
  }

  async function expectDone(page: Page): Promise<void> {
    await expect(page.getByTestId("sr-done")).toBeVisible();
    await expect(page).toHaveURL(options.url(DONE));
  }

  test("an action inside an intercept whose async handler streams under loading() follows the handler's redirect", async ({
    page,
  }) => {
    await show(page, "/slot-redirect", "sr-index");
    await page.getByTestId("sr-to-item").click();
    await expect(page.getByTestId("sr-modal")).toBeVisible();
    await expect(page).toHaveURL(options.url("/slot-redirect/item"));

    await page.getByTestId("sr-arm").click();
    await expectDone(page);
    await expect(page.getByTestId("sr-modal")).toHaveCount(0);
  });

  test("an action on a page whose async parallel slot streams under loading() follows the slot's redirect", async ({
    page,
  }) => {
    await show(page, "/slot-redirect/streamed", "sr-streamed-side");

    await page.getByTestId("sr-arm").click();
    await expectDone(page);
  });

  test("a parallel slot handler's returned redirect answers a document request", async ({
    page,
    context,
  }) => {
    await arm(context);
    await page.goto(options.url("/slot-redirect/plain"));
    await waitForShellHydration(page);
    await expectDone(page);
  });

  test("a parallel slot handler's returned redirect answers a client navigation", async ({
    page,
    context,
  }) => {
    await show(page, "/slot-redirect", "sr-index");
    await arm(context);
    await page.getByTestId("sr-to-plain").click();
    await expectDone(page);
  });

  // The request router.refresh() sends, replayed once the cookie is set. The
  // replay reads the server's answer itself: what the browser then does with a
  // redirect on a refresh is not this scenario's subject.
  test("a parallel slot handler's returned redirect answers the request router.refresh() sends", async ({
    page,
    context,
  }) => {
    await show(page, "/slot-redirect/plain", "sr-plain-side");
    const refreshRequest = page.waitForRequest((request) =>
      new URL(request.url()).searchParams.has("_rsc_stale"),
    );
    await page.getByTestId("sr-refresh").click();
    const request = await refreshRequest;
    await expect(page.getByTestId("sr-plain-side")).toBeVisible();

    await arm(context);
    const headers = Object.fromEntries(
      Object.entries(await request.allHeaders()).filter(
        ([name]) => name !== "cookie" && !name.startsWith(":"),
      ),
    );
    const answer = await page.request.get(request.url(), {
      headers,
      maxRedirects: 0,
    });
    expect(answer.status()).toBe(204);
    expect(answer.headers()["x-rsc-redirect"]).toBe(options.url(DONE));
  });
}
