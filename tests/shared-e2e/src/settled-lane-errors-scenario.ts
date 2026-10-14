import { expect, test, type Page, type Request } from "@playwright/test";
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
 * (a loader that throws once the layout's break action switched its run, or,
 * with `?once`, on its run's first call only), behind the 400 ms server
 * middleware. Both apps call this from a dev and a (production) describe.
 *
 * The contract, as on a plain navigation: the loader throws in place at its
 * useLoader read, the app's boundary there catches it, and the layout keeps
 * its instance; a redirect() replaces only the route's content. A prefetch
 * that finished with a loader error is never served to a click: the click
 * sends its own request, past the HTTP cache (dc-t72). The one exception is
 * the background refresh after Back onto a stale entry: a loader that throws
 * there leaves the stale page on screen and is logged.
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

/** A navigation's own request: an RSC request that is not a `<Link>` prefetch. */
function isClickRequestFor(request: Request, pathname: string): boolean {
  return (
    isRscRequestFor(request.url(), pathname) &&
    request.headers()["x-rango-prefetch"] !== "1"
  );
}

export function runSettledLaneErrorTests(
  options: SettledLaneErrorsScenarioOptions,
): void {
  const reported = options.production
    ? "An error occurred"
    : "stock service unavailable";

  async function openHome(page: Page, search = ""): Promise<void> {
    await page.goto(options.url(`${options.path}/${search}`));
    await expect(page.getByTestId("sle-home")).toBeVisible();
    await page.waitForFunction(() =>
      document.documentElement.hasAttribute("data-hydrated"),
    );
    await mark(page, "sle-layout");
  }

  /** Hovers a prefetch link and waits until its prefetch has drained. */
  async function prefetch(
    page: Page,
    link: string,
    target: string = link,
  ): Promise<void> {
    const response = page.waitForResponse((resp) =>
      isRscRequestFor(resp.url(), `${options.path}/${target}`),
    );
    await page.getByTestId(`sle-prefetch-${link}`).hover();
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
    test(`${variant.name}: a click whose prefetch finished with the loader's error sends its own request; the loader fails again and throws at the read, where the app's boundary catches it; the layout keeps its instance`, async ({
      page,
    }) => {
      await openHome(page);
      await prefetch(page, variant.target);

      const clicked = page.waitForRequest((req) =>
        isClickRequestFor(req, `${options.path}/${variant.target}`),
      );
      await page.getByTestId(`sle-prefetch-${variant.target}`).click();
      await clicked;
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

  /**
   * Opens /flaky, leaves it, breaks its loader with the action (which marks
   * every history entry stale) and goes Back: the background refresh's loader
   * throws. The page stays on screen and the failure is logged. Returns the
   * refresh's response body.
   */
  async function expectStaleRefreshKeepsPage(
    page: Page,
    beforeBack?: () => Promise<void>,
  ): Promise<string> {
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
    await beforeBack?.();

    const refreshed = page.waitForResponse((resp) =>
      isRscRequestFor(resp.url(), `${options.path}/flaky`),
    );
    await page.goBack();
    await expect(page.getByTestId("sle-flaky-value")).toHaveText("stock:1");
    const body = await (await refreshed).text();
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
    return body;
  }

  test("Back onto a stale entry whose loader throws in the background refresh keeps the page on screen and logs the failure; the layout keeps its instance", async ({
    page,
  }) => {
    await expectStaleRefreshKeepsPage(page);
  });

  // A refresh that reaches the server without the page it was sent from (a
  // proxy that drops X-RSC-Router-Client-Path and Referer) cannot be matched
  // partially, so the server answers it with the full page (dc-t68).
  test("Back onto a stale entry whose background refresh is answered with a full page keeps the page on screen when its loader throws", async ({
    page,
  }) => {
    const body = await expectStaleRefreshKeepsPage(page, async () => {
      await page.route(
        (url) =>
          url.pathname === `${options.path}/flaky` &&
          url.searchParams.get("_rsc_stale") === "true",
        async (route) => {
          // Sent from Playwright, not the page: the browser adds a Referer.
          const headers = { ...route.request().headers() };
          delete headers["x-rsc-router-client-path"];
          delete headers["referer"];
          await route.fulfill({ response: await route.fetch({ headers }) });
        },
      );
    });
    expect(body).toContain('"isPartial":false');
  });

  test("a click whose prefetch's loader failed and then answers shows the data the loader answers its own request with; the layout keeps its instance", async ({
    page,
  }) => {
    await openHome(page, `?run=${randomUUID()}`);
    // The run's first call, the prefetch, throws; the next one answers.
    await prefetch(page, "flaky-once", "flaky");

    const clicked = page.waitForRequest((req) =>
      isClickRequestFor(req, `${options.path}/flaky`),
    );
    await page.getByTestId("sle-prefetch-flaky-once").click();
    await clicked;
    await expect(page.getByTestId("sle-flaky-value")).toHaveText("stock:2");
    await expect(page.getByTestId("sle-app-boundary")).toHaveCount(0);
    await expectKept(page, "sle-layout");
  });

  test("a loader redirect() on a fully-prefetched click replaces only the route's content; the click is served from the prefetch; the layout keeps its instance", async ({
    page,
  }) => {
    await openHome(page);
    await prefetch(page, "gone");

    const clicked: string[] = [];
    page.on("request", (req) => {
      if (isClickRequestFor(req, `${options.path}/gone`)) {
        clicked.push(req.url());
      }
    });
    await page.getByTestId("sle-prefetch-gone").click();
    await expect(page).toHaveURL(new RegExp(`${options.path}/ok$`));
    await expect(page.getByTestId("sle-ok")).toBeVisible();
    await expectKept(page, "sle-layout");
    expect(clicked, "a redirect() is not a failed prefetch").toEqual([]);
  });
}
