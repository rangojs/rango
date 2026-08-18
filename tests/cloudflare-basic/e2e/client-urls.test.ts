import { expect, test, type Page } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
import {
  expectNoPageError,
  expectNoReload,
  getNumericContent,
  testId,
  waitForHydration,
} from "./helper";

async function expectResolvedDetail(page: Page, slug: string): Promise<void> {
  await expect(testId(page, "client-urls-detail")).toBeVisible();
  await expect(testId(page, "client-urls-param")).toHaveText(slug);
  await expect(testId(page, "client-urls-loader")).toHaveText(slug);
  await expect(testId(page, "client-urls-pending")).toHaveText("false");
  await expect(testId(page, "client-urls-loading")).toBeHidden();
}

function runClientUrlsSpec(f: Fixture): void {
  test("hard load SSRs and hydrates loader data, params, and settled outlet state", async ({
    page,
    request,
  }) => {
    const slug = "hard-load";
    const url = f.url(`/__client-urls/${slug}`);
    const response = await request.get(url, {
      headers: { accept: "text/html" },
    });
    const html = await response.text();
    expect(response.ok()).toBe(true);
    expect(html).toContain('data-testid="client-urls-layout"');
    expect(html).toContain('data-testid="client-urls-detail"');
    expect(html).toContain('data-testid="client-urls-param"');
    expect(html).toContain(slug);

    using _ = expectNoPageError(page);
    await page.goto(url);
    await waitForHydration(page);
    await expectResolvedDetail(page, slug);
  });

  test("hydrated soft navigation renders loading and pending state without reloading", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/__client-urls"));
    await waitForHydration(page);

    await expect(testId(page, "client-urls-index")).toBeVisible();
    await expect(testId(page, "client-urls-pending")).toHaveText("false");
    await using __ = await expectNoReload(page);

    const slug = "deterministic-slug";
    const detailPath = `/__client-urls/${slug}`;
    let releaseRequest!: () => void;
    const requestGate = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    await page.route(`**${detailPath}*`, async (route) => {
      await requestGate;
      await route.continue();
    });
    await testId(page, "client-urls-detail-link").click();
    try {
      await expect(testId(page, "client-urls-loading")).toBeVisible({
        timeout: 500,
      });
      await expect(testId(page, "client-urls-pending")).toHaveText("true", {
        timeout: 500,
      });
    } finally {
      releaseRequest();
    }

    await expectResolvedDetail(page, slug);
    await expect(page).toHaveURL(f.url(detailPath));

    await page.goBack();
    await expect(testId(page, "client-urls-index")).toBeVisible();
    await expect(testId(page, "client-urls-pending")).toHaveText("false");
    await expect(page).toHaveURL(f.url("/__client-urls"));
  });

  test("client revalidate() isAction() matches a target action and a namespace import", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/__client-urls"));
    await waitForHydration(page);
    await using __ = await expectNoReload(page);

    const readTarget = (): Promise<number> =>
      getNumericContent(testId(page, "cu-is-action-target-runs"));
    const readNs = (): Promise<number> =>
      getNumericContent(testId(page, "cu-is-action-ns-runs"));

    const initialTarget = await readTarget();
    const initialNs = await readNs();

    await testId(page, "cu-is-action-target").click();
    await expect.poll(readTarget).toBeGreaterThan(initialTarget);
    await expect.poll(readNs).toBeGreaterThan(initialNs);
    const afterTarget = await readTarget();
    const afterTargetNs = await readNs();

    await testId(page, "cu-is-action-decoy").click();
    await expect.poll(readNs).toBeGreaterThan(afterTargetNs);
    await expect(testId(page, "cu-is-action-target-runs")).toHaveText(
      String(afterTarget),
    );
  });

  test("ssr:false document render keeps the large awaited grid in-place (no outlining)", async ({
    request,
  }) => {
    // The route's loader is flagged { ssr: false }, so the document render is
    // awaited and the grid boundary COMPLETES by first flush. The grid is
    // sized past both Fizz outlining gates (see the fixture comment), so
    // without the progressiveChunkSize auto-raise Fizz emits its skeleton
    // in-place and moves the rows to an end-of-stream <div hidden> + $RC
    // reveal — presence checks can't see the difference, position can. The
    // unflagged chrome loaders above still stream, so hidden divs legitimately
    // exist later in the body.
    const response = await request.get(
      f.url("/__client-urls/mirror/awaited-slug"),
      { headers: { accept: "text/html" } },
    );
    const html = await response.text();
    expect(response.ok()).toBe(true);
    expect(html).toContain("mirror-awaited-data");
    expect(html).not.toContain("mirror-inline-grid-skeleton");
    const gridAt = html.indexOf('data-testid="mirror-inline-grid"');
    expect(gridAt).toBeGreaterThan(-1);
    const firstHiddenAt = html.indexOf("<div hidden");
    if (firstHiddenAt !== -1) {
      expect(gridAt).toBeLessThan(firstHiddenAt);
    }
  });

  test("main navigation reaches pure client routes and RSC layouts with client pages", async ({
    page,
    request,
  }) => {
    const mixedResponse = await request.get(f.url("/mixed-client-routes"), {
      headers: { accept: "text/html" },
    });
    const mixedHtml = await mixedResponse.text();
    expect(mixedResponse.ok()).toBe(true);
    expect(mixedHtml).toContain('data-testid="mixed-rsc-layout"');
    expect(mixedHtml).toContain('data-testid="mixed-client-index"');

    using _ = expectNoPageError(page);
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // One router serves everything now: the mixed group AND the pure client
    // group are include() mounts in the canonical urls() tree, so every hop —
    // including into and out of the pure client group — is a soft navigation.
    await using __ = await expectNoReload(page);

    await testId(page, "nav-mixed-client-routes").click();
    await expect(testId(page, "mixed-rsc-layout")).toBeVisible();
    await expect(testId(page, "mixed-client-index")).toBeVisible();
    await testId(page, "mixed-client-counter").click();
    await expect(testId(page, "mixed-client-counter")).toHaveText(
      "Client count: 1",
    );

    await testId(page, "mixed-client-detail-link").click();
    await expect(testId(page, "mixed-rsc-layout")).toBeVisible();
    await expect(testId(page, "mixed-client-loading")).toBeVisible();
    await expect(testId(page, "mixed-client-param")).toHaveText("example");
    await expect(testId(page, "mixed-client-loader")).toHaveText(
      "Cloudflare server loader: example",
    );
    await expect(page).toHaveURL(f.url("/mixed-client-routes/example"));

    await testId(page, "nav-home").click();
    await expect(page).toHaveURL(f.url("/"));
    await testId(page, "nav-pure-client-routes").click();
    await expect(testId(page, "client-urls-index")).toBeVisible();
    await expect(page).toHaveURL(f.url("/__client-urls"));

    await testId(page, "client-urls-main-nav").click();
    await expect(testId(page, "nav")).toBeVisible();
    await expect(page).toHaveURL(f.url("/"));
  });
}

test.describe("clientUrls", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  runClientUrlsSpec(f);
});

test.describe("clientUrls (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  runClientUrlsSpec(f);
});
