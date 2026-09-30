import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { expectNoPageError, testId, waitForHydration } from "./helper";

/**
 * #1007 (cloudflare-basic mirror of packages/rangojs-router/e2e/
 * prefetch-intercept-source): a prefetched intercept target is scoped to the
 * page it was fetched from, whether or not the intercept applied there. The
 * iws modal (fixture: src/pages/intercept-when-shape.tsx) does not apply from
 * /list/closed, so a prefetch of /item/1 from there is the full page. A later
 * click from /list/open must not reuse it: the modal opens.
 *
 * Control: /list/:section, which no intercept targets, keeps the shared
 * prefetch slot (#474): one prefetch serves clicks from two other pages.
 */

const BASE = "/intercept-when-shape";

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

async function goSection(page: Page, link: string, section: string) {
  await testId(page, link).click();
  await expect(testId(page, "iws-section")).toHaveText(section, {
    timeout: 8000,
  });
}

function defineSuite(f: ReturnType<typeof useFixture>) {
  test("an intercept target prefetched where the intercept does not apply still opens the modal from a page where it does", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    const itemRequests = recordPartials(page, `${BASE}/item/1`);

    await page.goto(f.url(`${BASE}/list/closed`));
    await waitForHydration(page);
    await expect(testId(page, "iws-section")).toHaveText("closed");

    const prefetched = waitForPartial(page, `${BASE}/item/1`);
    await testId(page, "iws-to-1-pf").hover();
    const response = await prefetched;
    await response.finished();

    await goSection(page, "iws-to-open", "open");
    await testId(page, "iws-to-1").click();
    await expect(testId(page, "iws-modal-id")).toHaveText("1", {
      timeout: 8000,
    });
    await expect(testId(page, "iws-item-page")).toHaveCount(0);
    await expect(testId(page, "iws-list")).toBeVisible();
    expect(itemRequests[0], "the prefetch fired from /list/closed").toBe(
      `${BASE}/list/closed`,
    );
    expect(
      itemRequests.slice(1),
      "the click from /list/open fetched (or prefetched) from its own source",
    ).toContain(`${BASE}/list/open`);
    expect(response.headers()["x-rsc-prefetch-scope"]).toBe("source");
  });

  test("control: a route no intercept targets serves clicks from two pages with one prefetch", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    const otherRequests = recordPartials(page, `${BASE}/list/other`);

    await page.goto(f.url(`${BASE}/list/closed`));
    await waitForHydration(page);
    await expect(testId(page, "iws-section")).toHaveText("closed");

    const prefetched = waitForPartial(page, `${BASE}/list/other`);
    await testId(page, "iws-to-other-pf").hover();
    const response = await prefetched;
    await response.finished();
    expect(response.headers()["x-rsc-prefetch-scope"]).toBeUndefined();

    await goSection(page, "iws-to-open", "open");
    await goSection(page, "iws-to-other-pf", "other");
    await goSection(page, "iws-to-closed", "closed");
    await goSection(page, "iws-to-other-pf", "other");
    expect(
      otherRequests,
      "one prefetch from /list/closed served open and closed",
    ).toEqual([`${BASE}/list/closed`]);
  });
}

test.describe("prefetch-intercept-source (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  test.setTimeout(60000);
  defineSuite(f);
});

test.describe("prefetch-intercept-source (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  test.setTimeout(60000);
  defineSuite(f);
});
