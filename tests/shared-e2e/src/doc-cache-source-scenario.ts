import { expect, test, type Page } from "@playwright/test";
import { waitForShellHydration } from "./shell-request.js";

/**
 * rango-t238: the document cache keys a partial by its URL and the ids the
 * client holds, not by the page it was sent from. A category layout renders
 * the category's hero, and its revalidate() re-renders it only when the
 * source page's category differs. From /c/audio the click to
 * /c/audio?sort=x keeps the hero, an answer right for an audio page only;
 * from /c/tv, which holds the same ids, the same click must render the audio
 * hero. The route opts into the document cache (s-maxage); ?k keys its
 * entries to one test. Fixture: doc-cache-source* in each app, mounted at
 * "/doc-cache-source" behind createDocumentCacheMiddleware(); both apps call
 * this from a dev and a (production) describe.
 */
export interface DocCacheSourceScenarioOptions {
  url: (pathname: string) => string;
}

const BASE = "/doc-cache-source";

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await waitForShellHydration(page);
}

export function runDocCacheSourceTests(
  options: DocCacheSourceScenarioOptions,
): void {
  test("a click the hero was kept for on an audio page is not served to a tv page from the document cache", async ({
    page,
  }) => {
    const k = `k${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
    const sorted = `${BASE}/c/audio`;

    await open(page, options.url(`${BASE}/c/audio?k=${k}`));
    await expect(page.getByTestId("dcs-hero")).toHaveText("hero:audio");

    /** The response of the click to the sorted audio PLP. */
    const clickSorted = async () => {
      const navigation = page.waitForResponse(
        (resp) =>
          new URL(resp.url()).pathname === sorted &&
          new URL(resp.url()).searchParams.get("sort") === "x",
      );
      await page.getByTestId("dcs-to-audio-sorted").click();
      const response = await navigation;
      await response.finished();
      return response;
    };

    const fromAudio = await clickSorted();
    await expect(page.getByTestId("dcs-page")).toHaveText("plp:audio:x");
    await expect(page.getByTestId("dcs-hero")).toHaveText("hero:audio");

    // A tv page holds the same ids. Its click renders the audio hero: served
    // the answer above, it would keep its tv hero over the audio PLP.
    await open(page, options.url(`${BASE}/c/tv?k=${k}`));
    await expect(page.getByTestId("dcs-hero")).toHaveText("hero:tv");
    const fromTv = await clickSorted();
    await expect(page.getByTestId("dcs-page")).toHaveText("plp:audio:x");
    await expect(page.getByTestId("dcs-hero")).toHaveText("hero:audio");
    // The cache is in front of the route: the tv answer, which re-rendered
    // the hero and is right from every page, is a MISS it stores.
    expect(fromTv.headers()["x-document-cache-status"]).toBe("MISS");

    // The answer that kept the hero for an audio page was not stored, and no
    // shared cache may store it.
    expect(fromAudio.headers()["x-document-cache-status"]).toBeUndefined();
    expect(fromAudio.headers()["cache-control"]).toBe("private, no-cache");
  });
}
