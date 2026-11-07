import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { expectNoPageError, testId } from "./helper";

// /mdx-page renders src/pages/mdx-page.mdx, compiled by @mdx-js/rollup
// (vite.config.ts). urls.tsx imports it statically, so discovery's temp server
// evaluates it and has to run that transform too; without it vite:import-analysis
// rejects the raw markdown, the production build fails and in dev every request
// answers 500. /mdx-prerender loads src/pages/mdx-prerender.mdx with import()
// inside a Prerender handler, so only the prerender, in the same temp server,
// reaches it. In dev a failed prerender falls back to a live render, so only
// the production case fails without the transform.

/** Renders /mdx-<name>: heading "MDX <name>", bold text and a JSX element. */
async function expectMdxRoute(page: Page, url: string, name: string) {
  using _ = expectNoPageError(page);

  const response = await page.goto(url);
  expect(response?.status()).toBe(200);

  const article = testId(page, `mdx-${name}`);
  await expect(article.locator("h1")).toHaveText(`MDX ${name}`);
  await expect(article.locator("strong")).toHaveText("@mdx-js/rollup");
  await expect(testId(page, `mdx-${name}-content`)).toHaveText(
    `mdx-${name}-ok`,
  );
}

test.describe("mdx imports (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });

  test("renders a route that imports an .mdx module", async ({ page }) => {
    await expectMdxRoute(page, f.url("/mdx-page"), "page");
  });

  test("renders a Prerender route that imports an .mdx module", async ({
    page,
  }) => {
    await expectMdxRoute(page, f.url("/mdx-prerender"), "prerender");
  });
});

test.describe("mdx imports (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });

  test("renders a route that imports an .mdx module", async ({ page }) => {
    await expectMdxRoute(page, f.url("/mdx-page"), "page");
  });

  test("renders a Prerender route that imports an .mdx module", async ({
    page,
  }) => {
    await expectMdxRoute(page, f.url("/mdx-prerender"), "prerender");
  });
});
