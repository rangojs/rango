import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * Tests that internal _rsc* query params are stripped from ctx.url and
 * ctx.searchParams in route handlers.
 *
 * During client-side navigation the browser sends params like _rsc_partial,
 * _rsc_segments, _rsc_v in the request URL. These must not leak into the
 * handler context that userland code sees.
 */
test.describe("ctx internal param stripping", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("SSR: ctx.url and ctx.searchParams should not contain _rsc params", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Direct document request with user query params
    await page.goto(f.url("/ctx-clean?q=hello&page=1"));
    await waitForHydration(page);

    await expect(testId(page, "ctx-clean-page")).toBeVisible();

    // ctx.url.search should only have user params
    const urlSearch = await testId(page, "ctx-url-search").textContent();
    expect(urlSearch).toContain("q=hello");
    expect(urlSearch).toContain("page=1");
    expect(urlSearch).not.toContain("_rsc");

    // ctx.searchParams keys should only have user keys
    const paramKeys = await testId(page, "ctx-param-keys").textContent();
    expect(paramKeys).toContain("page");
    expect(paramKeys).toContain("q");
    expect(paramKeys).not.toContain("_rsc");
  });

  test("client navigation: ctx.url and ctx.searchParams should not contain _rsc params", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Start at source page (different route so navigation triggers partial render)
    await page.goto(f.url("/ctx-clean/source"));
    await waitForHydration(page);

    // Click link to navigate to target page with query params.
    // This triggers a partial RSC request that includes _rsc_partial, _rsc_segments, etc.
    await testId(page, "navigate-to-target").click();

    // Wait for the target page to render
    await expect(testId(page, "ctx-url-search")).toContainText("q=navigated");

    // Verify no _rsc params leaked into handler context
    const urlSearch = await testId(page, "ctx-url-search").textContent();
    expect(urlSearch).toContain("q=navigated");
    expect(urlSearch).toContain("page=2");
    expect(urlSearch).not.toContain("_rsc");

    const paramKeys = await testId(page, "ctx-param-keys").textContent();
    expect(paramKeys).not.toContain("_rsc");
  });
});

test.describe("ctx internal param stripping (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("SSR: ctx.url and ctx.searchParams should not contain _rsc params", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/ctx-clean?q=hello&page=1"));
    await waitForHydration(page);

    await expect(testId(page, "ctx-clean-page")).toBeVisible();

    const urlSearch = await testId(page, "ctx-url-search").textContent();
    expect(urlSearch).toContain("q=hello");
    expect(urlSearch).toContain("page=1");
    expect(urlSearch).not.toContain("_rsc");

    const paramKeys = await testId(page, "ctx-param-keys").textContent();
    expect(paramKeys).toContain("page");
    expect(paramKeys).toContain("q");
    expect(paramKeys).not.toContain("_rsc");
  });

  test("client navigation: ctx.url and ctx.searchParams should not contain _rsc params", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    // Start at source page (different route triggers partial render)
    await page.goto(f.url("/ctx-clean/source"));
    await waitForHydration(page);

    // Click link to navigate with query params (triggers _rsc* params in request)
    await testId(page, "navigate-to-target").click();

    await expect(testId(page, "ctx-url-search")).toContainText("q=navigated");

    const urlSearch = await testId(page, "ctx-url-search").textContent();
    expect(urlSearch).toContain("q=navigated");
    expect(urlSearch).toContain("page=2");
    expect(urlSearch).not.toContain("_rsc");

    const paramKeys = await testId(page, "ctx-param-keys").textContent();
    expect(paramKeys).not.toContain("_rsc");
  });
});
