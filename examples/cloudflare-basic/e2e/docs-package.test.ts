import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  testId,
} from "./helper";

test.describe.configure({ mode: "serial" });

test.describe("composable docs package", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("GET /docs renders index page with article list", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/docs"));
    await waitForHydration(page);

    await expect(testId(page, "docs-index")).toBeVisible();
    await expect(testId(page, "docs-title")).toHaveText("Documentation");
    await expect(testId(page, "docs-list")).toBeVisible();

    const items = page.locator('[data-testid^="docs-item-"]');
    await expect(items).toHaveCount(3);
  });

  test("GET /docs/:slug renders article detail", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/docs/getting-started"));
    await waitForHydration(page);

    await expect(testId(page, "docs-detail")).toBeVisible();
    await expect(testId(page, "docs-detail-title")).toHaveText("Getting Started");
    await expect(testId(page, "docs-detail-content")).toBeVisible();
    await expect(testId(page, "docs-back-link")).toBeVisible();
    await expect(testId(page, "docs-raw-link")).toBeVisible();
  });

  test("GET /docs/:slug/raw returns text/markdown", async ({ request }) => {
    const response = await request.get(f.url("/docs/getting-started/raw"));
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/markdown");
    const body = await response.text();
    expect(body).toContain("Welcome to Rango!");
  });

  test("GET /docs/:slug/raw returns not-found for unknown slug", async ({ request }) => {
    const response = await request.get(f.url("/docs/nonexistent/raw"));
    expect(response.status()).toBe(200);
    const body = await response.text();
    expect(body).toContain("# Not Found");
  });

  test("GET /docs/api/search returns all articles when no query", async ({ request }) => {
    const response = await request.get(f.url("/docs/api/search"));
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/json");
    const body = await response.json();
    expect(body.data.total).toBe(3);
    expect(body.data.results).toHaveLength(3);
  });

  test("GET /docs/api/search?q=routing filters results", async ({ request }) => {
    const response = await request.get(f.url("/docs/api/search?q=routing"));
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.data.total).toBeGreaterThanOrEqual(1);
    const titles = body.data.results.map((r: { title: string }) => r.title);
    expect(titles).toContain("Routing Patterns");
  });

  test("GET /docs/api/search?q=nonexistent returns empty", async ({ request }) => {
    const response = await request.get(f.url("/docs/api/search?q=zzzznonexistent"));
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.data.total).toBe(0);
    expect(body.data.results).toHaveLength(0);
  });

  test("navigate from index to detail via link click", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/docs"));
    await waitForHydration(page);

    await testId(page, "docs-link-getting-started").click();
    await expect(page).toHaveURL(/\/docs\/getting-started/);
    await expect(testId(page, "docs-detail")).toBeVisible();
    await expect(testId(page, "docs-detail-title")).toHaveText("Getting Started");
  });

  test("navigate from detail back to index via back link", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/docs/getting-started"));
    await waitForHydration(page);

    await testId(page, "docs-back-link").click();
    await expect(page).toHaveURL(/\/docs$/);
    await expect(testId(page, "docs-index")).toBeVisible();
  });

  test("nav bar contains docs link", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    const docsLink = testId(page, "nav-docs");
    await expect(docsLink).toBeVisible();
    await expect(docsLink).toHaveText("Docs");
  });

  test("navigate to docs from home via nav link", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await testId(page, "nav-docs").click();
    await expect(page).toHaveURL(/\/docs/);
    await expect(testId(page, "docs-index")).toBeVisible();
  });

  test("unknown slug renders not-found state", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/docs/nonexistent"));
    await waitForHydration(page);

    await expect(testId(page, "docs-not-found")).toBeVisible();
  });
});

test.describe("composable docs package (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test("GET /docs renders index in production", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/docs"));
    await waitForHydration(page);

    await expect(testId(page, "docs-index")).toBeVisible();
    await expect(testId(page, "docs-title")).toHaveText("Documentation");

    const items = page.locator('[data-testid^="docs-item-"]');
    await expect(items).toHaveCount(3);
  });

  test("GET /docs/:slug renders detail in production", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/docs/composable-packages"));
    await waitForHydration(page);

    await expect(testId(page, "docs-detail")).toBeVisible();
    await expect(testId(page, "docs-detail-title")).toHaveText("Composable Packages");
  });

  test("GET /docs/:slug/raw returns markdown in production", async ({ request }) => {
    const response = await request.get(f.url("/docs/routing-patterns/raw"));
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/markdown");
    const body = await response.text();
    expect(body).toContain("Nested Layouts");
  });

  test("GET /docs/api/search returns JSON in production", async ({ request }) => {
    const response = await request.get(f.url("/docs/api/search?q=composable"));
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/json");
    const body = await response.json();
    expect(body.data.total).toBeGreaterThanOrEqual(1);
  });
});
