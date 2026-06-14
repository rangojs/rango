import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

// An inline "use server" action embedded in a CACHED value, exercised on workerd
// across BOTH caching mechanisms:
//   - a build-time prerendered article (/articles/:slug, Prerender) -- the
//     canonical article + like-button case;
//   - a runtime-cached blog post (/blog/:slug, wrapped in cache()).
//
// On a cache/prerender HIT the handler is not re-run, so the embedded action must
// resolve from the stored Flight, decrypt its bound args, and re-serialize to the
// client. Before the encryption-key fix this failed in Cloudflare DEV (the Node
// discovery temp server that renders prerender used its own random key). Pinned
// here in dev AND production: the captured slug is frozen per item, the action
// body runs live (fresh value), and request scope is live (cookie read in body).

const captured = (page: Page) => testId(page, "inline-like-captured");
const asyncCell = (page: Page) => testId(page, "inline-like-async");
const userCell = (page: Page) => testId(page, "inline-like-user");
const likeBtn = (page: Page) => testId(page, "inline-like-button");

const readAsync = async (page: Page) =>
  (await asyncCell(page).textContent())!.replace(/^async:/, "");
const setUser = (page: Page, url: string, value: string) =>
  page.context().addCookies([{ name: "cb-like-user", value, url }]);

// Real slugs from content/articles/*.md and the blog fixtures.
const ARTICLE_A = "what-is-prerendering";
const ARTICLE_B = "edge-rendering";
const BLOG_SLUG = "getting-started-with-rsc";

function defineSpec(label: string, mode: "dev" | "build") {
  test.describe(`embedded inline action (${label})`, () => {
    const f = useFixture({ root: ".", mode });

    test("article like button resolves on a prerender hit (per-article frozen slug, live body)", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Per-article frozen capture: each prerendered article's action carries its
      // own slug; the body reads the live cookie and a fresh value.
      for (const slug of [ARTICLE_A, ARTICLE_B]) {
        const url = f.url(`/articles/${slug}`);
        await setUser(page, url, `u-${slug}`);
        await page.goto(url);
        await waitForHydration(page);
        await expect(testId(page, "article-detail")).toBeVisible();

        await likeBtn(page).click();
        await expect(userCell(page)).toHaveText(`user:u-${slug}`);
        await expect(captured(page)).toHaveText(`captured:${slug}`);
        expect(await readAsync(page)).toMatch(/^like-/);
      }

      // Live body: a second invocation (new cookie) returns a fresh async value.
      const url = f.url(`/articles/${ARTICLE_A}`);
      await setUser(page, url, "u-1");
      await page.goto(url);
      await waitForHydration(page);
      await likeBtn(page).click();
      await expect(userCell(page)).toHaveText("user:u-1");
      const a1 = await readAsync(page);

      await setUser(page, url, "u-2");
      await likeBtn(page).click();
      await expect(userCell(page)).toHaveText("user:u-2");
      expect(await readAsync(page)).not.toBe(a1);
    });

    test("blog like button resolves on a runtime-cache hit (frozen slug, live body)", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);
      const url = f.url(`/blog/${BLOG_SLUG}`);

      // First visit populates the cache; reload forces a cache HIT served from
      // the stored Flight (the handler is not re-run).
      await setUser(page, url, "u-blog");
      await page.goto(url);
      await waitForHydration(page);
      await expect(testId(page, "blog-post-detail")).toBeVisible();
      await page.reload();
      await waitForHydration(page);

      await likeBtn(page).click();
      await expect(userCell(page)).toHaveText("user:u-blog");
      await expect(captured(page)).toHaveText(`captured:${BLOG_SLUG}`);
      expect(await readAsync(page)).toMatch(/^like-/);
    });
  });
}

defineSpec("dev", "dev");
defineSpec("production", "build");
