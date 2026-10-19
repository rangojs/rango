import { expect, test, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { guardHydrationErrors } from "./hydration-guard.js";
import {
  waitForShellHydration,
  warmShellRequestToHit,
} from "./shell-request.js";

/**
 * A `ppr` route with a `loader(Def, { ssr: false })` and a completed Suspense
 * boundary past both Fizz outlining gates (#1206). The live render raises
 * `progressiveChunkSize` for such a route, so the boundary ships in place; a
 * shell HIT must too, instead of painting the fallback and revealing the
 * content from an outlined `<div hidden>` segment. The route also has a live
 * hole, so the HIT resumes. Fixture: shell-cache-inline / ppr-inline in each
 * app.
 */

export interface PprSsrFalseInlineScenarioOptions {
  url: (pathname: string) => string;
  /** The route's path. */
  path: string;
  /**
   * The fixture's test id prefix: `<prefix>-grid`, `<prefix>-grid-skeleton`
   * (its fallback), `<prefix>-live` and `<prefix>-live-fallback` (the hole).
   */
  testIdPrefix: string;
}

const HTML_HEADERS = { Accept: "text/html" };

async function getDocument(
  request: APIRequestContext,
  url: string,
): Promise<{ shell: string | undefined; html: string }> {
  const res = await request.get(url, { headers: HTML_HEADERS });
  expect(res.status()).toBe(200);
  return { shell: res.headers()["x-rango-shell"], html: await res.text() };
}

export function runPprSsrFalseInlineTests(
  options: PprSsrFalseInlineScenarioOptions,
): void {
  const grid = `${options.testIdPrefix}-grid`;
  const skeleton = `${options.testIdPrefix}-grid-skeleton`;

  // Position, not presence: an outlined boundary has its rows in the HTML
  // too, in a <div hidden> segment after its fallback. Soft, so the browser
  // check below still runs and reports when the markup is wrong.
  function expectGridInPlace(html: string): void {
    expect.soft(html).not.toContain(`data-testid="${skeleton}"`);
    const gridAt = html.indexOf(`data-testid="${grid}"`);
    expect.soft(gridAt).toBeGreaterThan(-1);
    const firstHiddenAt = html.indexOf("<div hidden");
    if (firstHiddenAt !== -1) expect.soft(gridAt).toBeLessThan(firstHiddenAt);
  }

  test("a shell HIT ships an ssr: false route's completed boundary in place, as the live render does", async ({
    page,
  }) => {
    const url = options.url(`${options.path}?probe=${randomUUID()}`);

    const miss = await getDocument(page.request, url);
    expect(miss.shell).toBe("MISS");
    expectGridInPlace(miss.html);

    // The capture runs in the background of the MISS.
    await warmShellRequestToHit(page.request, url);

    const hit = await getDocument(page.request, url);
    expect(hit.shell).toBe("HIT");
    expectGridInPlace(hit.html);
    const preludeEnd = hit.html.indexOf("</html>");
    expect(preludeEnd).toBeGreaterThan(-1);
    const prelude = hit.html.slice(0, preludeEnd);
    // The live hole: its fallback is in the shell, its value resumes after.
    expect(prelude).toContain(
      `data-testid="${options.testIdPrefix}-live-fallback"`,
    );
    expect(hit.html.slice(preludeEnd)).toContain(
      `data-testid="${options.testIdPrefix}-live"`,
    );

    // The browser never shows the grid's fallback, not even for a frame.
    await page.addInitScript((selector: string) => {
      const w = self as unknown as { __skeletonSeen?: boolean };
      w.__skeletonSeen = false;
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (
              node instanceof Element &&
              (node.matches(selector) || node.querySelector(selector))
            ) {
              w.__skeletonSeen = true;
            }
          }
        }
      }).observe(document, { childList: true, subtree: true });
    }, `[data-testid="${skeleton}"]`);

    using _ = guardHydrationErrors(page);
    const response = await page.goto(url);
    expect(response?.headers()["x-rango-shell"]).toBe("HIT");
    await waitForShellHydration(page);
    await expect(page.getByTestId(grid)).toBeVisible();
    await expect(
      page.getByTestId(`${options.testIdPrefix}-live`),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => (self as unknown as { __skeletonSeen?: boolean }).__skeletonSeen,
      ),
    ).toBe(false);
  });
}
