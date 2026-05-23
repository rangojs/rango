import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, expectNoReload } from "./helper";

test.describe("prerender-handler (dev mode)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("static prerender handler renders on-demand", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/docs"));
    await waitForHydration(page);

    await expect(page.locator('[data-testid="docs-title"]')).toContainText(
      "Documentation",
    );
    await expect(page.locator('[data-testid="docs-content"]')).toContainText(
      "pre-rendered documentation content",
    );
    await expect(page.locator('[data-testid="docs-pathname"]')).toContainText(
      "/docs",
    );
  });

  test("dynamic prerender handler renders with params", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/docs/getting-started"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="docs-article-title"]'),
    ).toContainText("getting-started");
    await expect(
      page.locator('[data-testid="docs-article-content"]'),
    ).toContainText("Content for getting-started");
  });

  test("prerender client component resolves loader, action, and locationState", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/docs/getting-started"));
    await waitForHydration(page);

    // Loader data should be resolved and rendered by useLoader
    await expect(
      page.locator('[data-testid="prerender-loader-data"]'),
    ).toContainText("prerender-loader-data");
    await expect(
      page.locator('[data-testid="prerender-loader-test"]'),
    ).toContainText("true");

    // useAction should work with directly imported action
    await expect(
      page.locator('[data-testid="prerender-action-state"]'),
    ).toContainText("idle");

    // Verify loader has $$id injected
    const loaderJson = await page
      .locator('[data-testid="prerender-loader-json"]')
      .textContent();
    const loaderObj = JSON.parse(loaderJson!);
    expect(loaderObj.$$id).toBeTruthy();

    // Verify action has $$id injected (via direct import, not prop)
    const actionId = await page
      .locator('[data-testid="prerender-action-id"]')
      .textContent();
    expect(actionId).not.toBe("no-action-id");

    // Verify location state has __rsc_ls_key injected
    const locationStateKey = await page
      .locator('[data-testid="prerender-location-state-key"]')
      .textContent();
    expect(locationStateKey).not.toBe("no-ls-key");
  });

  test("Static handler on non-parameterized route renders in dev", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-page"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="static-page-title"]'),
    ).toContainText("Static Page");
    await expect(
      page.locator('[data-testid="static-page-content"]'),
    ).toContainText("This is a statically pre-rendered page.");
  });

  test("Static handler pushes breadcrumb handle data in dev", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-page"));
    await waitForHydration(page);

    // The Static handler pushes a "Static Page" breadcrumb.
    // BreadcrumbNav should render it (alongside "Home" from RootLayout).
    await expect(page.locator('[data-testid="breadcrumbs"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="breadcrumbs-current"]'),
    ).toContainText("Static Page");
  });

  test("Static handler on parameterized route serves content for any param", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Visit with one param value
    await page.goto(f.url("/static-shell/hello"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="static-shell-title"]'),
    ).toContainText("Static Shell");
    await expect(
      page.locator('[data-testid="static-shell-content"]'),
    ).toContainText("This content is the same for every param.");

    // Visit with a completely different param value -- should get the same content
    await page.goto(f.url("/static-shell/world"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="static-shell-title"]'),
    ).toContainText("Static Shell");
    await expect(
      page.locator('[data-testid="static-shell-content"]'),
    ).toContainText("This content is the same for every param.");
  });

  test("dynamic prerender handler renders different params", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/docs/api-reference"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="docs-article-title"]'),
    ).toContainText("api-reference");
    await expect(
      page.locator('[data-testid="docs-article-content"]'),
    ).toContainText("Content for api-reference");
  });

  test("client navigation to prerender route works", async ({ page }) => {
    using _ = expectNoPageError(page);

    // Start at the index page
    await page.goto(f.url("/"));
    await waitForHydration(page);

    // Navigate to a prerender route
    await page.goto(f.url("/docs/api-reference"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="docs-article-title"]'),
    ).toContainText("api-reference");
  });
});

test.describe("prerender non-prerendered param (dev mode)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("unknown slug renders on-demand in dev mode", async ({ page }) => {
    using _ = expectNoPageError(page);

    // In dev mode, the full handler code is present so it renders fine
    await page.goto(f.url("/docs/unknown-slug"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="docs-article-title"]'),
    ).toContainText("unknown-slug");
    await expect(
      page.locator('[data-testid="docs-article-content"]'),
    ).toContainText("Content for unknown-slug");
  });
});

test.describe("prerender non-prerendered param (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("non-prerendered slug returns 404, not 500", async ({ page }) => {
    // Regression: production stubs have no handler function. Visiting a slug
    // that was NOT returned by getParams() must return 404, not crash with
    // "routeEntry.handler is not a function".
    const response = await page.goto(f.url("/docs/unknown-slug"));
    expect(response?.status()).toBe(404);
  });

  test("non-prerendered slug renders notFoundBoundary UI", async ({ page }) => {
    await page.goto(f.url("/docs/unknown-slug"));

    // The notFoundBoundary on docs.article should catch DataNotFoundError
    // from the prerender stub and render custom 404 UI.
    await expect(
      page.locator('[data-testid="docs-not-found-title"]'),
    ).toContainText("Doc Not Found");
    await expect(
      page.locator('[data-testid="docs-not-found-message"]'),
    ).toBeVisible();

    // Should NOT show an error/500 page
    await expect(page.locator("text=Internal Server Error")).not.toBeVisible();
  });
});

test.describe("prerender-complex (dev mode)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("runtime layout wraps pre-rendered index", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-complex"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="prerender-complex-layout"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="prerender-complex-index-title"]'),
    ).toContainText("Complex Index");
  });

  test("runtime layout wraps pre-rendered detail", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-complex/alpha"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="prerender-complex-layout"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="prerender-complex-detail-title"]'),
    ).toContainText("alpha");
  });

  test("inner layout renders inside pre-rendered detail", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-complex/beta"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="prerender-inner-layout"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="prerender-complex-detail-title"]'),
    ).toContainText("beta");
  });

  test("parallel sidebar renders on index", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-complex"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="prerender-sidebar"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="prerender-sidebar-title"]'),
    ).toContainText("Sidebar");
  });

  test("parallel sidebar absent on detail", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-complex/alpha"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="prerender-sidebar"]'),
    ).not.toBeVisible();
  });

  test("loader data is fresh on reload (index)", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-complex"));
    await waitForHydration(page);

    const ts1 = await page
      .locator('[data-testid="fresh-timestamp"]')
      .textContent();
    expect(Number(ts1)).toBeGreaterThan(0);

    await page.reload();
    await waitForHydration(page);

    const ts2 = await page
      .locator('[data-testid="fresh-timestamp"]')
      .textContent();
    expect(Number(ts2)).toBeGreaterThan(0);
    expect(ts2).not.toBe(ts1);
  });

  test("loader data is fresh on reload (detail)", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-complex/alpha"));
    await waitForHydration(page);

    const ts1 = await page
      .locator('[data-testid="fresh-timestamp"]')
      .textContent();
    expect(Number(ts1)).toBeGreaterThan(0);

    await page.reload();
    await waitForHydration(page);

    const ts2 = await page
      .locator('[data-testid="fresh-timestamp"]')
      .textContent();
    expect(Number(ts2)).toBeGreaterThan(0);
    expect(ts2).not.toBe(ts1);
  });
});

test.describe("Static handler (production build)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("Static on non-dynamic route renders", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-page"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="static-page-title"]'),
    ).toContainText("Static Page");
  });

  test("Static on non-dynamic route has stable timestamp across reloads (truly pre-rendered)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-page"));
    await waitForHydration(page);

    const ts1 = await page
      .locator('[data-testid="static-page-timestamp"]')
      .textContent();

    await page.reload();
    await waitForHydration(page);

    const ts2 = await page
      .locator('[data-testid="static-page-timestamp"]')
      .textContent();

    // If truly pre-rendered, timestamp should be identical (frozen at build time)
    expect(ts1).toBe(ts2);
  });

  test("Static on dynamic route serves content for any param value", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-shell/hello"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="static-shell-title"]'),
    ).toContainText("Static Shell");
  });

  test("Static on dynamic route serves same content for different param", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-shell/totally-different-value"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="static-shell-title"]'),
    ).toContainText("Static Shell");
  });
});

test.describe("prerender-complex (production build)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("runtime layout wraps pre-rendered index", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-complex"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="prerender-complex-layout"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="prerender-complex-index-title"]'),
    ).toContainText("Complex Index");
  });

  test("runtime layout wraps pre-rendered detail", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-complex/alpha"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="prerender-complex-layout"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="prerender-complex-detail-title"]'),
    ).toContainText("alpha");
  });

  test("inner layout renders inside pre-rendered detail", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-complex/beta"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="prerender-inner-layout"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="prerender-complex-detail-title"]'),
    ).toContainText("beta");
  });

  test("parallel sidebar renders on index", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-complex"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="prerender-sidebar"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="prerender-sidebar-title"]'),
    ).toContainText("Sidebar");
  });

  test("parallel sidebar absent on detail", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-complex/alpha"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="prerender-sidebar"]'),
    ).not.toBeVisible();
  });

  test("loader data is fresh on reload (index)", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-complex"));
    await waitForHydration(page);

    const ts1 = await page
      .locator('[data-testid="fresh-timestamp"]')
      .textContent();
    expect(Number(ts1)).toBeGreaterThan(0);

    await page.reload();
    await waitForHydration(page);

    const ts2 = await page
      .locator('[data-testid="fresh-timestamp"]')
      .textContent();
    expect(Number(ts2)).toBeGreaterThan(0);
    expect(ts2).not.toBe(ts1);
  });

  test("loader data is fresh on reload (detail)", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-complex/alpha"));
    await waitForHydration(page);

    const ts1 = await page
      .locator('[data-testid="fresh-timestamp"]')
      .textContent();
    expect(Number(ts1)).toBeGreaterThan(0);

    await page.reload();
    await waitForHydration(page);

    const ts2 = await page
      .locator('[data-testid="fresh-timestamp"]')
      .textContent();
    expect(Number(ts2)).toBeGreaterThan(0);
    expect(ts2).not.toBe(ts1);
  });

  test("pre-rendered handler content stays identical while loader timestamps differ", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-complex"));
    await waitForHydration(page);

    const content1 = await page
      .locator('[data-testid="prerender-complex-index-content"]')
      .textContent();
    const ts1 = await page
      .locator('[data-testid="fresh-timestamp"]')
      .textContent();

    await page.reload();
    await waitForHydration(page);

    const content2 = await page
      .locator('[data-testid="prerender-complex-index-content"]')
      .textContent();
    const ts2 = await page
      .locator('[data-testid="fresh-timestamp"]')
      .textContent();

    // Pre-rendered content stays the same
    expect(content1).toBe(content2);
    // Loader timestamp changes
    expect(ts1).not.toBe(ts2);
  });

  test("client navigation from index to prerender-complex", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await page.goto(f.url("/prerender-complex"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="prerender-complex-index-title"]'),
    ).toContainText("Complex Index");
  });

  test("client navigation between index and detail preserves parent layout", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-complex"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="prerender-complex-layout"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="prerender-complex-index-title"]'),
    ).toContainText("Complex Index");

    // Navigate to detail
    await page.goto(f.url("/prerender-complex/alpha"));
    await waitForHydration(page);

    // Parent layout should still be there
    await expect(
      page.locator('[data-testid="prerender-complex-layout"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="prerender-complex-detail-title"]'),
    ).toContainText("alpha");
  });
});

test.describe("reverse() in Prerender/Static handlers", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("Prerender handler can use ctx.reverse() and getRequestContext().reverse()", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-reverse"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="prerender-reverse-title"]'),
    ).toContainText("Prerender Reverse");
    await expect(
      page.locator('[data-testid="prerender-reverse-blog"]'),
    ).toHaveText("/blog");
    await expect(
      page.locator('[data-testid="prerender-reverse-href"]'),
    ).toHaveText("/href");
  });

  test("Static handler can use ctx.reverse() and getRequestContext().reverse()", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-reverse"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="static-reverse-title"]'),
    ).toContainText("Static Reverse");
    await expect(
      page.locator('[data-testid="static-reverse-blog"]'),
    ).toHaveText("/blog");
    await expect(
      page.locator('[data-testid="static-reverse-href"]'),
    ).toHaveText("/href");
  });
});

test.describe("reverse() in Prerender/Static handlers (production build)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("Prerender handler resolves reverse() in production", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-reverse"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="prerender-reverse-blog"]'),
    ).toHaveText("/blog");
    await expect(
      page.locator('[data-testid="prerender-reverse-href"]'),
    ).toHaveText("/href");
  });

  test("Static handler resolves reverse() in production", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-reverse"));
    await waitForHydration(page);

    await expect(
      page.locator('[data-testid="static-reverse-blog"]'),
    ).toHaveText("/blog");
    await expect(
      page.locator('[data-testid="static-reverse-href"]'),
    ).toHaveText("/href");
  });
});

// Issue #500: the discovery runner must honor the user's third-party resolveId
// plugins (e.g. vite-tsconfig-paths). StaticPage/DocsPage import "@parity/marker"
// which is resolved ONLY by the `test-parity-alias` resolveId plugin in
// vite.config.ts (no resolve.alias mirror). In dev the main RSC env resolves it
// natively; in production the build-time static/prerender rendering goes through
// the temp discovery runner, which only resolves it if user plugins are forwarded.
test.describe("resolveId-plugin parity (dev mode)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("alias-only resolveId plugin resolves in Static handler", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-page"));
    await waitForHydration(page);

    await expect(page.locator('[data-testid="static-page-parity"]')).toHaveText(
      "resolveid-plugin-parity-ok",
    );
  });

  test("alias-only resolveId plugin resolves in Prerender handler", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/docs"));
    await waitForHydration(page);

    await expect(page.locator('[data-testid="docs-parity"]')).toHaveText(
      "resolveid-plugin-parity-ok",
    );
  });
});

test.describe("resolveId-plugin parity (production build)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("alias-only resolveId plugin resolves in build-time Static handler", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-page"));
    await waitForHydration(page);

    await expect(page.locator('[data-testid="static-page-parity"]')).toHaveText(
      "resolveid-plugin-parity-ok",
    );
  });

  test("alias-only resolveId plugin resolves in build-time Prerender handler", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/docs"));
    await waitForHydration(page);

    await expect(page.locator('[data-testid="docs-parity"]')).toHaveText(
      "resolveid-plugin-parity-ok",
    );
  });
});
