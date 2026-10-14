import {
  expect,
  test,
  type Page,
  type Request,
  type Response,
} from "@playwright/test";
import { randomUUID } from "node:crypto";

/**
 * A prefetch whose render reported an error is never kept (#1170). Fixture:
 * prefetch-render-errors* in each app, behind the 400 ms server middleware:
 * a layout holding hover-prefetch links that carry the page's `run`,
 * `/handler` and `/slow` (a loading() handler that fails on its run's first
 * call into its errorBoundary(), `/slow` after 1.5 s), `/loader` (the
 * settled-lane fixture's `?once` loader, read under loading(), which fails on
 * its run's first call). Both apps call this from a dev and a (production)
 * describe.
 *
 * The contract: a prefetch whose render reported an error ends cleanly with
 * one more Flight row the decoder skips, and the client drops it as a stream
 * that did not end cleanly: never served, never respawned. No prefetch
 * carries Cache-Control, so the HTTP cache keeps none either. A click after it
 * sends its own request, and a new document's prefetch of the URL reaches the
 * server. A click that adopted the prefetch while it streamed renders all of
 * it, error boundary in place.
 */
export interface PrefetchRenderErrorsScenarioOptions {
  url: (pathname: string) => string;
  /** The fixture's include() mount. */
  path: string;
}

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

function isPrefetch(request: Request): boolean {
  return request.headers()["x-rango-prefetch"] === "1";
}

/** PREFETCH_FAILED_ROW (packages/rangojs-router/src/prefetch-markers.ts). */
const FAILED_ROW = ":H_0\n";

/** Whether a prefetch's body ended with the failure row; asserts no Cache-Control. */
async function failed(response: Response): Promise<boolean> {
  expect(response.headers()["cache-control"]).toBeUndefined();
  return (await response.body()).toString().endsWith(FAILED_ROW);
}

export function runPrefetchRenderErrorTests(
  options: PrefetchRenderErrorsScenarioOptions,
): void {
  const at = (name: string) => `${options.path}/${name}`;

  async function openHome(page: Page, run: string): Promise<void> {
    await page.goto(options.url(`${options.path}/?run=${run}`));
    await expect(page.getByTestId("pre-home")).toBeVisible();
    await page.waitForFunction(() =>
      document.documentElement.hasAttribute("data-hydrated"),
    );
    await mark(page, "pre-layout");
  }

  /** Hovers a prefetch link; resolves with its response once headers arrive. */
  async function hoverPrefetch(page: Page, name: string): Promise<Response> {
    const response = page.waitForResponse(
      (resp) =>
        isRscRequestFor(resp.url(), at(name)) && isPrefetch(resp.request()),
    );
    await page.getByTestId(`pre-prefetch-${name}`).hover();
    return response;
  }

  /** Hovers a prefetch link; resolves once its body ended: whether it failed. */
  async function prefetch(page: Page, name: string): Promise<boolean> {
    return failed(await hoverPrefetch(page, name));
  }

  /** The navigation requests (not prefetches) for `name` from now on. */
  function trackClicks(page: Page, name: string): string[] {
    const clicks: string[] = [];
    page.on("request", (req) => {
      if (isRscRequestFor(req.url(), at(name)) && !isPrefetch(req)) {
        clicks.push(req.url());
      }
    });
    return clicks;
  }

  test("a click after a prefetch whose loading() handler failed sends its own request and shows the page it renders, not the prefetched boundary; the layout keeps its instance", async ({
    page,
  }) => {
    await openHome(page, randomUUID());
    const ended = await prefetch(page, "handler");

    const clicks = trackClicks(page, "handler");
    await page.getByTestId("pre-prefetch-handler").click();
    await expect(page.getByTestId("pre-value")).toHaveText("handler:2");
    await expect(page.getByTestId("pre-boundary")).toHaveCount(0);
    await expectKept(page, "pre-layout");
    expect(clicks, "the click sends its own request").toHaveLength(1);
    expect(ended, "the prefetch ended with the failure row").toBe(true);
  });

  for (const name of ["handler", "loader"]) {
    test(`a new document's prefetch of a URL whose ${name} failed in an earlier prefetch reaches the server, not the HTTP cache`, async ({
      page,
    }) => {
      await openHome(page, randomUUID());
      // The run's first call fails.
      const first = await prefetch(page, name);

      await page.reload();
      await expect(page.getByTestId("pre-home")).toBeVisible();
      await page.waitForFunction(() =>
        document.documentElement.hasAttribute("data-hydrated"),
      );
      const second = await prefetch(page, name);

      const clicks = trackClicks(page, name);
      await page.getByTestId(`pre-prefetch-${name}`).click();
      await expect(page.getByTestId("pre-value")).toHaveText(
        `${name === "loader" ? "stock" : name}:2`,
      );
      expect(clicks, "the click is served from the healthy prefetch").toEqual(
        [],
      );
      expect(second, "the second prefetch is healthy").toBe(false);
      expect(first, "the first prefetch ended with the failure row").toBe(true);
    });
  }

  test("a click that adopted a still-streaming prefetch whose handler then failed renders the page with the boundary in place, without a request of its own, a remount or an error; the next prefetch is fresh", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
    });
    await openHome(page, randomUUID());

    // Headers arrived; the handler fails 1.5 s later.
    const response = await hoverPrefetch(page, "slow");
    const ended = failed(response);
    const clicks = trackClicks(page, "slow");
    await page.getByTestId("pre-prefetch-slow").click();
    await expect(page).toHaveURL(new RegExp(`${at("slow")}\\?`));
    await expect(page.getByTestId("pre-boundary")).toHaveText("failed");
    await expect(page.getByTestId("pre-value")).toHaveCount(0);
    await expect(page.getByTestId("pre-skeleton")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Internal Server Error" }),
    ).toHaveCount(0);
    await expectKept(page, "pre-layout");
    expect(clicks, "the click adopted the prefetch").toEqual([]);
    test.info().annotations.push({
      type: "console errors",
      description: errors.join("\n") || "none",
    });
    expect(
      errors.filter((e) =>
        /Connection closed|terminated|network|ERR_|\[(rango|Rango|Browser|RSC|RootErrorBoundary)\]/i.test(
          e,
        ),
      ),
    ).toEqual([]);

    // Not kept after the adopting click: the next visit renders fresh.
    await page.getByTestId("pre-link-home").click();
    await expect(page.getByTestId("pre-home")).toBeVisible();
    expect(await prefetch(page, "slow")).toBe(false);
    await page.getByTestId("pre-prefetch-slow").click();
    await expect(page.getByTestId("pre-value")).toHaveText("slow:2");
    await expectKept(page, "pre-layout");
    expect(await ended, "the adopted prefetch ended with the failure row").toBe(
      true,
    );
  });
}
