import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { expectNoPageError, testId } from "./helper";

// /mdx-page renders src/components/MdxPage.mdx, compiled by @mdx-js/rollup
// (test-app/vite.config.ts). urls.tsx imports it statically, so discovery's
// temp server evaluates it and has to run that transform too; without it the
// production build fails in vite:import-analysis on the raw markdown.
// /mdx-prerender loads MdxPrerender.mdx with import() inside a Prerender
// handler, so only the build-time prerender, in the same temp server, reaches it.
// Dev renders it in the main runner, which has the transform either way.

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

test.describe("mdx imports", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });

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
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });

  test("renders a route that imports an .mdx module", async ({ page }) => {
    await expectMdxRoute(page, f.url("/mdx-page"), "page");
  });

  test("renders a Prerender route that imports an .mdx module", async ({
    page,
  }) => {
    await expectMdxRoute(page, f.url("/mdx-prerender"), "prerender");
  });
});
