import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { expectConsole } from "./console-guard.js";

/**
 * A loader whose result is an error or a redirect(), committed by a lane that
 * settles loader data before its commit (dc-t65): a fully-prefetched click
 * (its prefetch drained before the click) and Back onto an entry restored
 * from the history cache. Fixture: settled-lane-errors* in each app, a layout
 * holding the links, `/fail` and `/fail-loading` (a loader that always
 * throws, read inside the app's own error boundary, without and with
 * `loading()`), `/gone` (a loader that throws redirect() to `/ok`), `/flaky`
 * (a loader that throws once the layout's break action switched its run),
 * behind the 400 ms server middleware. Both apps call this from a dev and a
 * (production) describe.
 *
 * The contract, as on a plain navigation: the loader throws in place at its
 * useLoader read, the app's boundary there catches it, and the layout keeps
 * its instance; a redirect() replaces only the route's content. The one
 * exception is the background refresh after Back onto a stale entry: a
 * loader that throws there leaves the stale page on screen and is logged.
 */
export interface SettledLaneErrorsScenarioOptions {
  url: (pathname: string) => string;
  /** The fixture's include() mount. */
  path: string;
  /** A build: an error's message reaches the browser as "An error occurred". */
  production: boolean;
}

/** Marks an element; a remount drops the mark. */
async function mark(page: Page, testId: string): Promise<void> {
  await page
    .getByTestId(testId)
    .evaluate((el) => el.setAttribute("data-e2e-kept", "1"));
}

async function expectKept(page: Page, testId: string): Promise<void> {
  await expect(page.getByTestId(testId)).toHaveAttribute("data-e2e-kept", "1");
}

function isRscRequestFor(url: string, pathname: string): boolean {
  const u = new URL(url);
  return u.pathname === pathname && u.searchParams.has("_rsc_partial");
}

export function runSettledLaneErrorTests(
  options: SettledLaneErrorsScenarioOptions,
): void {
  const reported = options.production
    ? "An error occurred"
    : "stock service unavailable";

  async function openHome(page: Page): Promise<void> {
    await page.goto(options.url(`${options.path}/`));
    await expect(page.getByTestId("sle-home")).toBeVisible();
    await page.waitForFunction(() =>
      document.documentElement.hasAttribute("data-hydrated"),
    );
    await mark(page, "sle-layout");
  }

  /** Hovers a prefetch link and waits until its prefetch has drained. */
  async function prefetch(page: Page, target: string): Promise<void> {
    const response = page.waitForResponse((resp) =>
      isRscRequestFor(resp.url(), `${options.path}/${target}`),
    );
    await page.getByTestId(`sle-prefetch-${target}`).hover();
    await (await response).finished();
  }

  async function expectThrownInPlace(page: Page): Promise<void> {
    await expect(page.getByTestId("sle-app-boundary")).toHaveText(reported);
    await expect(page.getByTestId("sle-fail-page")).toBeVisible();
    await expect(page.getByTestId("sle-value")).toHaveCount(0);
    await expectKept(page, "sle-layout");
    await expect(
      page.getByRole("heading", { name: "Internal Server Error" }),
    ).toHaveCount(0);
  }

  for (const variant of [
    { name: "route without loading()", target: "fail" },
    { name: "route with loading()", target: "fail-loading" },
  ]) {
    test(`${variant.name}: a fully-prefetched click to a page whose loader fails throws at the read, where the app's boundary catches it; the layout keeps its instance`, async ({
      page,
    }) => {
      await openHome(page);
      await prefetch(page, variant.target);

      await page.getByTestId(`sle-prefetch-${variant.target}`).click();
      await expect(page).toHaveURL(
        new RegExp(`${options.path}/${variant.target}$`),
      );
      await expectThrownInPlace(page);
    });

    test(`${variant.name}: Back onto an entry whose loader failed restores it from the history cache, with the error at the app's boundary at the read; the layout keeps its instance`, async ({
      page,
    }) => {
      await openHome(page);
      await page.getByTestId(`sle-link-${variant.target}`).click();
      await expectThrownInPlace(page);
      await page.getByTestId("sle-link-ok").click();
      await expect(page.getByTestId("sle-ok")).toBeVisible();

      // The entry's own URL only: a build viewport-prefetches the app's links.
      const fetched: string[] = [];
      page.on("request", (req) => {
        if (isRscRequestFor(req.url(), `${options.path}/${variant.target}`)) {
          fetched.push(req.url());
        }
      });
      await page.goBack();
      await expect(page).toHaveURL(
        new RegExp(`${options.path}/${variant.target}$`),
      );
      await expectThrownInPlace(page);
      expect(fetched, "Back is restored from the history cache").toEqual([]);
    });
  }

  test("Back onto a stale entry whose loader throws in the background refresh keeps the page on screen and logs the failure; the layout keeps its instance", async ({
    page,
  }) => {
    expectConsole(page, { allow: [/Background revalidation failed/] });
    const logged: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") logged.push(message.text());
    });
    await page.goto(options.url(`${options.path}/?run=${randomUUID()}`));
    await expect(page.getByTestId("sle-home")).toBeVisible();
    await page.waitForFunction(() =>
      document.documentElement.hasAttribute("data-hydrated"),
    );
    await mark(page, "sle-layout");
    await page.getByTestId("sle-link-flaky").click();
    await expect(page.getByTestId("sle-flaky-value")).toHaveText("stock:1");
    await page.getByTestId("sle-link-ok").click();
    await expect(page.getByTestId("sle-ok")).toBeVisible();
    // The action switches the flaky loader to throw and marks every history
    // entry stale.
    await page.getByTestId("sle-break").click();
    await expect(page.getByTestId("sle-break-outcome")).toHaveText("broken");

    const refreshed = page.waitForResponse((resp) =>
      isRscRequestFor(resp.url(), `${options.path}/flaky`),
    );
    await page.goBack();
    await expect(page.getByTestId("sle-flaky-value")).toHaveText("stock:1");
    await (await refreshed).finished();
    await expect
      .poll(() =>
        logged.some((text) => text.includes("Background revalidation failed")),
      )
      .toBe(true);
    await expect(page.getByTestId("sle-flaky-value")).toHaveText("stock:1");
    await expect(page.getByTestId("sle-app-boundary")).toHaveCount(0);
    await expectKept(page, "sle-layout");
    await expect(
      page.getByRole("heading", { name: "Internal Server Error" }),
    ).toHaveCount(0);
  });

  test("a loader redirect() on a fully-prefetched click replaces only the route's content; the layout keeps its instance", async ({
    page,
  }) => {
    await openHome(page);
    await prefetch(page, "gone");

    await page.getByTestId("sle-prefetch-gone").click();
    await expect(page).toHaveURL(new RegExp(`${options.path}/ok$`));
    await expect(page.getByTestId("sle-ok")).toBeVisible();
    await expectKept(page, "sle-layout");
  });
}
