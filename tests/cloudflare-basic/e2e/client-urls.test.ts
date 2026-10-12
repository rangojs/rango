import { expect, test, type Page } from "@playwright/test";
import {
  expectKeptLayoutReadingItsLoaderKeepsTheOptimisticFrame,
  expectReturnToCommittedRouteFromOptimisticFrameShowsTheDestination,
} from "@shared/e2e";
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

  test("a layout() keeps its DOM across navigations between its routes (#1124)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/__client-urls"));
    await waitForHydration(page);
    await expect(testId(page, "client-urls-index")).toBeVisible();
    // A remount replaces the element, and the attribute goes with it.
    await testId(page, "client-urls-layout").evaluate((el) =>
      el.setAttribute("data-e2e-kept", "1"),
    );

    await using __ = await expectNoReload(page);
    await testId(page, "client-urls-detail-link").click();
    await expectResolvedDetail(page, "deterministic-slug");
    await expect(testId(page, "client-urls-layout")).toHaveAttribute(
      "data-e2e-kept",
      "1",
    );

    await page.goBack();
    await expect(testId(page, "client-urls-index")).toBeVisible();
    await expect(testId(page, "client-urls-layout")).toHaveAttribute(
      "data-e2e-kept",
      "1",
    );

    // A server action in the group re-runs its loaders, not its layout.
    const runs = await getNumericContent(
      testId(page, "cu-is-action-target-runs"),
    );
    await testId(page, "cu-is-action-target").click();
    await expect
      .poll(() => getNumericContent(testId(page, "cu-is-action-target-runs")))
      .toBeGreaterThan(runs);
    await expect(testId(page, "client-urls-layout")).toHaveAttribute(
      "data-e2e-kept",
      "1",
    );
  });

  test("a layout() that reads its own loader keeps the optimistic frame and its instance across its routes", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectKeptLayoutReadingItsLoaderKeepsTheOptimisticFrame(page, {
      url: (pathname) => f.url(pathname),
      path: "/client-urls-layout-loader",
    });
  });

  test("a click to the committed route from another route's optimistic frame shows its destination, never the committed params' data", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await expectReturnToCommittedRouteFromOptimisticFrameShowsTheDestination(
      page,
      {
        url: (pathname) => f.url(pathname),
        path: "/client-urls-layout-loader",
      },
    );
  });

  test("a group loader's revalidate() isAction() matches a target action and a namespace import", async ({
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

  test("a group loader's revalidate() sees the action result: re-runs after ok, holds after fail", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/__client-urls"));
    await waitForHydration(page);
    await using __ = await expectNoReload(page);

    const readResult = (): Promise<number> =>
      getNumericContent(testId(page, "cu-result-runs"));
    const readNs = (): Promise<number> =>
      getNumericContent(testId(page, "cu-is-action-ns-runs"));

    const before = await readResult();
    await testId(page, "cu-result-ok").click();
    await expect.poll(readResult).toBeGreaterThan(before);
    const afterOk = await readResult();

    // The namespace-gated loader re-runs on every action of that module:
    // once it advanced, the fail action's commit landed.
    const nsBefore = await readNs();
    await testId(page, "cu-result-fail").click();
    await expect.poll(readNs).toBeGreaterThan(nsBefore);
    await expect(testId(page, "cu-result-runs")).toHaveText(String(afterOk));
  });

  test("a clientUrls() intercept loader's revalidate() sees the action result", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/__client-urls-intercept"));
    await waitForHydration(page);
    await using __ = await expectNoReload(page);
    await testId(page, "cui-note-link").click();
    await expect(testId(page, "cui-modal")).toBeVisible();

    const readResult = (): Promise<number> =>
      getNumericContent(testId(page, "cui-modal-result-runs"));
    const readNs = (): Promise<number> =>
      getNumericContent(testId(page, "cui-modal-ns-runs"));
    const before = await readResult();
    await testId(page, "cui-modal-ok").click();
    await expect.poll(readResult).toBeGreaterThan(before);
    const afterOk = await readResult();

    // The namespace-gated loader re-runs on every action of that module:
    // once it advanced, the fail action's commit landed.
    const nsBefore = await readNs();
    await testId(page, "cui-modal-fail").click();
    await expect.poll(readNs).toBeGreaterThan(nsBefore);
    await expect(testId(page, "cui-modal-result-runs")).toHaveText(
      String(afterOk),
    );
    await expect(testId(page, "cui-index")).toBeVisible();
  });

  test("clientUrls(): an in-group prefetch of an intercept target defers the flagged intercept loader", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/__client-urls-intercept"));
    await waitForHydration(page);
    await using __ = await expectNoReload(page);

    const target = "/__client-urls-intercept/note/b";
    const kinds: string[] = [];
    let fillSource: string | null = null;
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname !== target || !url.searchParams.has("_rsc_partial")) {
        return;
      }
      if (url.searchParams.has("_rsc_fill")) {
        kinds.push("fill");
        fillSource = request.headers()["x-rsc-router-intercept-source"] ?? "";
      } else {
        kinds.push(
          request.headers()["x-rango-prefetch"] === "1"
            ? "prefetch"
            : "navigation",
        );
      }
    });
    const prefetched = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === target &&
        response.request().headers()["x-rango-prefetch"] === "1",
    );
    await testId(page, "cui-note-prefetch-link").hover();
    await (await prefetched).finished();
    await page.mouse.move(0, 0);

    await testId(page, "cui-note-prefetch-link").click();
    await expect(testId(page, "cui-modal")).toBeVisible();
    await expect(testId(page, "cui-modal-note-runs")).toBeVisible();
    await expect(testId(page, "cui-index")).toBeVisible();
    // The prefetch deferred the flagged loader; the click's one fill, from
    // the intercept's source, ran it.
    expect(kinds).toEqual(["prefetch", "fill"]);
    expect(fillSource && new URL(fillSource, f.url("/")).href).toBe(
      f.url("/__client-urls-intercept"),
    );
  });

  test("revalidate(true) re-runs a group loader where the default holds; revalidate(false) holds where the default re-runs", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/__client-urls"));
    await waitForHydration(page);
    await using __ = await expectNoReload(page);

    // Each value on screen changes only when its loader re-ran.
    const read = (id: string) => (): Promise<number> =>
      getNumericContent(testId(page, id));
    const readAlways = read("cu-always-runs");
    const readResult = read("cu-result-runs");
    const held = await read("cu-held-runs")();

    // An action: the default re-runs the result loader (onResultOk defers
    // on any other action) and revalidate(true) re-runs too; revalidate(false)
    // holds.
    const always = await readAlways();
    const result = await readResult();
    await testId(page, "cu-is-action-target").click();
    await expect.poll(readResult).toBeGreaterThan(result);
    await expect.poll(readAlways).toBeGreaterThan(always);
    await expect(testId(page, "cu-held-runs")).toHaveText(String(held));

    // A same-URL navigation: same params and search, so the default holds
    // the result loader; revalidate(true) re-runs.
    const alwaysAfterAction = await readAlways();
    const resultAfterAction = await readResult();
    await testId(page, "cu-self").click();
    await expect.poll(readAlways).toBeGreaterThan(alwaysAfterAction);
    await expect(testId(page, "cu-result-runs")).toHaveText(
      String(resultAfterAction),
    );
    await expect(testId(page, "cu-held-runs")).toHaveText(String(held));
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

  test("async include() mounts a clientUrls module directly (no server wrapper)", async ({
    page,
    request,
  }) => {
    // urls.tsx mounts mixed-client/urls.js a second time through
    // `include("/mixed-client-async", () => import("./mixed-client/urls.js"))`.
    // The provider resolves to the module's client reference; the group must
    // SSR, hydrate, and serve its projected loader under the async mount.
    const response = await request.get(f.url("/mixed-client-async"), {
      headers: { accept: "text/html" },
    });
    expect(response.ok()).toBe(true);
    expect(await response.text()).toContain('data-testid="mixed-client-index"');

    using _ = expectNoPageError(page);
    await page.goto(f.url("/mixed-client-async"));
    await waitForHydration(page);
    await expect(testId(page, "mixed-client-index")).toBeVisible();
    await testId(page, "mixed-client-counter").click();
    await expect(testId(page, "mixed-client-counter")).toHaveText(
      "Client count: 1",
    );

    await page.goto(f.url("/mixed-client-async/example"));
    await waitForHydration(page);
    await expect(testId(page, "mixed-client-param")).toHaveText("example");
    await expect(testId(page, "mixed-client-loader")).toHaveText(
      "Cloudflare server loader: example",
    );
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
