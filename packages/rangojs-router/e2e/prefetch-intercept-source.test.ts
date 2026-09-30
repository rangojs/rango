import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";
import { goTxSrc } from "./transition-when-helpers";

/**
 * #1007: a prefetched intercept target is scoped to the page it was fetched
 * from, whether or not the intercept applied there. The product modal
 * intercept (`when`: from "/") does not apply from /tx-src/a, so a prefetch of
 * /product/product-a from there is the full page. A later click from "/" must
 * not reuse it: the modal opens.
 *
 * Control: a route no intercept targets keeps the shared prefetch slot
 * (#474). /tx-src/c is render-prefetched from every /tx-src page; one request
 * serves clicks from two other pages.
 *
 * Fixtures: test-app/src/urls.tsx (product modal intercept),
 * test-app/src/urls/conditional-transition.tsx (/tx-src/:n).
 */

/** Source pathnames of the partial requests for `pathname`, in order. */
function recordPartials(page: Page, pathname: string): string[] {
  const sources: string[] = [];
  page.on("request", (req) => {
    const u = new URL(req.url());
    if (u.pathname !== pathname || !u.searchParams.has("_rsc_partial")) return;
    const source = req.headers()["x-rsc-router-client-path"];
    sources.push(source ? new URL(source).pathname : "?");
  });
  return sources;
}

function waitForPartial(page: Page, pathname: string) {
  return page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === pathname &&
      new URL(r.url()).searchParams.has("_rsc_partial"),
    { timeout: 15000 },
  );
}

function defineSuite(f: ReturnType<typeof useFixture>) {
  test("an intercept target prefetched where the intercept does not apply still opens the modal from a page where it does", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    const productRequests = recordPartials(page, "/product/product-a");

    await page.goto(f.url("/tx-src/a"));
    await waitForHydration(page);
    await expect(testId(page, "tx-src-n")).toHaveText("a", { timeout: 8000 });

    const prefetched = waitForPartial(page, "/product/product-a");
    await testId(page, "tx-src-to-product-a-pf").hover();
    const response = await prefetched;
    await response.finished();

    await testId(page, "nav-home").click();
    await expect(testId(page, "index-page")).toBeVisible({ timeout: 8000 });

    await testId(page, "product-link-product-a").click();
    await expect(testId(page, "product-modal")).toBeVisible({ timeout: 8000 });
    await expect(testId(page, "product-detail-page")).toHaveCount(0);
    await expect(testId(page, "index-page")).toBeVisible();
    expect(productRequests[0], "the prefetch fired from /tx-src/a").toBe(
      "/tx-src/a",
    );
    expect(
      productRequests.slice(1),
      "the click from / fetched (or prefetched) from its own source",
    ).toContain("/");
    expect(response.headers()["x-rsc-prefetch-scope"]).toBe("source");
  });

  test("control: a route no intercept targets serves clicks from two pages with one prefetch", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    const cRequests = recordPartials(page, "/tx-src/c");

    const prefetched = waitForPartial(page, "/tx-src/c");
    await page.goto(f.url("/tx-src/a"));
    await waitForHydration(page);
    const response = await prefetched;
    await response.finished();
    expect(response.headers()["x-rsc-prefetch-scope"]).toBeUndefined();

    await goTxSrc(page, "tx-src-to-b", "b");
    await goTxSrc(page, "tx-src-to-c-pf", "c");
    await goTxSrc(page, "tx-src-to-d", "d");
    await goTxSrc(page, "tx-src-to-c-pf", "c");
    expect(cRequests, "one prefetch from /tx-src/a served b and d").toEqual([
      "/tx-src/a",
    ]);
  });
}

test.describe("prefetch-intercept-source (dev)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  test.setTimeout(60000);
  defineSuite(f);
});

test.describe("prefetch-intercept-source (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  test.setTimeout(60000);
  defineSuite(f);
});
