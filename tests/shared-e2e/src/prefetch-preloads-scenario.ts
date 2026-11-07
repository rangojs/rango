import { expect, test, type Response } from "@playwright/test";
import { waitForShellHydration } from "./shell-request.js";

/**
 * A viewport prefetch does not download the target page's images: the
 * `preload()` hints in its Flight payload for anything but styles, fonts and
 * scripts are held, and the click that uses the prefetch starts them.
 *
 * Fixture: prefetch-preloads* in each app, mounted at "/prefetch-preloads": a
 * layout with a `prefetch="viewport"` link to `/target` above `/home`, and
 * `/target`, which calls `preload("/prefetch-preloads/hero.svg", { as:
 * "image" })`, then `preload("/prefetch-preloads/kept.css", { as: "style" })`,
 * and renders no image. A style preload is not held, so once its request
 * leaves, the prefetch's decode has passed the hero's row. The test serves
 * both and counts their requests. Both apps call this from a dev and a
 * (production) describe.
 */
export interface PrefetchPreloadsScenarioOptions {
  url: (pathname: string) => string;
}

const BASE = "/prefetch-preloads";
const HERO = `${BASE}/hero.svg`;
const KEPT = `${BASE}/kept.css`;
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>`;

function isTargetPartial(response: Response): boolean {
  const url = new URL(response.url());
  return (
    url.pathname === `${BASE}/target` && url.searchParams.has("_rsc_partial")
  );
}

export function runPrefetchPreloadsTests(
  options: PrefetchPreloadsScenarioOptions,
): void {
  test("a viewport prefetch holds the target page's image preload until the click that uses it", async ({
    page,
  }) => {
    const heroRequests: string[] = [];
    await page.route(`**${HERO}`, (route) => {
      heroRequests.push(route.request().url());
      return route.fulfill({ contentType: "image/svg+xml", body: SVG });
    });
    const keptRequests: string[] = [];
    await page.route(`**${KEPT}`, (route) => {
      keptRequests.push(route.request().url());
      return route.fulfill({ contentType: "text/css", body: "" });
    });
    const partials: Response[] = [];
    page.on("response", (response) => {
      if (isTargetPartial(response)) partials.push(response);
    });
    const prefetched = page.waitForResponse(
      (response) =>
        isTargetPartial(response) &&
        response.request().headers()["x-rango-prefetch"] === "1",
    );

    await page.goto(options.url(`${BASE}/home`));
    await waitForShellHydration(page);
    const prefetch = await prefetched;
    // The hint is in the payload: the server sent it, the client held it.
    expect((await prefetch.body()).toString()).toContain(`"${HERO}"`);
    await expect.poll(() => keptRequests.length).toBe(1);
    expect(heroRequests).toEqual([]);
    await expect(
      page.locator(`link[rel="preload"][href="${HERO}"]`),
    ).toHaveCount(0);

    await page.getByTestId("pp-to-target").click();
    await expect(page.getByTestId("pp-target")).toBeVisible();
    await expect(
      page.locator(`link[rel="preload"][href="${HERO}"]`),
    ).toHaveCount(1);
    await expect.poll(() => heroRequests.length).toBe(1);
    // The prefetch served the click: no second request for the page.
    expect(partials).toHaveLength(1);
  });
}
