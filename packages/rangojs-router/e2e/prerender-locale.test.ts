import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

// -- Dev mode ----------------------------------------------------------------
// Prerender handler mounted under parameterized include("/:locale", ...).
// In dev, getParams does not run; handler renders on-demand with both
// parent (locale) and child (slug) params from the URL.

test.describe("prerender locale params (dev mode)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test("handler renders with correct locale and slug", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/en/blog/hello"));
    await waitForHydration(page);

    await expect(testId(page, "locale-detail-title")).toContainText("hello");
    await expect(testId(page, "locale-detail-locale")).toContainText("en");
  });

  test("ctx.build is true in dev prerender", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/en/blog/hello"));
    await waitForHydration(page);

    await expect(testId(page, "locale-detail-build")).toContainText("true");
  });

  test("layout receives handler data via ctx.get()", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/en/blog/hello"));
    await waitForHydration(page);

    await expect(testId(page, "locale-layout-content")).toContainText(
      "content-en-hello",
    );
  });

  test("different locale same slug produces different content", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/en/blog/hello"));
    await waitForHydration(page);
    await expect(testId(page, "locale-detail-content")).toContainText(
      "content-en-hello",
    );

    await page.goto(f.url("/fr/blog/hello"));
    await waitForHydration(page);
    await expect(testId(page, "locale-detail-content")).toContainText(
      "content-fr-hello",
    );
  });

  test("ctx.reverse auto-fills locale param for sibling route", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/en/blog/hello"));
    await waitForHydration(page);

    // reverse(".list") should produce /en/blog with locale auto-filled
    await expect(testId(page, "locale-detail-list-url")).toContainText(
      "/en/blog",
    );
  });

  test("ctx.reverse auto-fills fr locale for sibling route", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/fr/blog/world"));
    await waitForHydration(page);

    await expect(testId(page, "locale-detail-list-url")).toContainText(
      "/fr/blog",
    );
  });

  test("list route renders with locale param", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/en/blog"));
    await waitForHydration(page);

    await expect(testId(page, "locale-list-title")).toContainText(
      "Blog list for en",
    );
  });
});

// -- Production build --------------------------------------------------------
// In production, getParams runs at build time and returns all locale x slug
// combos. Pre-rendered content is frozen — timestamps don't change on reload.

test.describe("prerender locale params (production build)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("pre-rendered en/hello renders correctly", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/en/blog/hello"));
    await waitForHydration(page);

    await expect(testId(page, "locale-detail-title")).toContainText("hello");
    await expect(testId(page, "locale-detail-locale")).toContainText("en");
    await expect(testId(page, "locale-detail-content")).toContainText(
      "content-en-hello",
    );
  });

  test("pre-rendered fr/hello has different content than en/hello", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/en/blog/hello"));
    await waitForHydration(page);
    const enContent = await testId(page, "locale-detail-content").textContent();

    await page.goto(f.url("/fr/blog/hello"));
    await waitForHydration(page);
    const frContent = await testId(page, "locale-detail-content").textContent();

    expect(enContent).toBe("content-en-hello");
    expect(frContent).toBe("content-fr-hello");
    expect(enContent).not.toBe(frContent);
  });

  test("pre-rendered timestamps are stable across reloads", async ({
    page,
  }) => {
    await page.goto(f.url("/en/blog/hello"));
    await waitForHydration(page);

    const ts1 = await testId(page, "locale-detail-timestamp").textContent();

    await page.reload();
    await waitForHydration(page);

    const ts2 = await testId(page, "locale-detail-timestamp").textContent();

    expect(ts1).toBe(ts2);
  });

  test("layout has correct handler data in pre-rendered content", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/fr/blog/world"));
    await waitForHydration(page);

    await expect(testId(page, "locale-layout-content")).toContainText(
      "content-fr-world",
    );
  });

  test("ctx.build is true for pre-rendered content", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/en/blog/hello"));
    await waitForHydration(page);

    await expect(testId(page, "locale-detail-build")).toContainText("true");
  });

  test("ctx.reverse auto-fills locale param in pre-rendered content", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/fr/blog/hello"));
    await waitForHydration(page);

    await expect(testId(page, "locale-detail-list-url")).toContainText(
      "/fr/blog",
    );
  });

  test("all four locale x slug combos are pre-rendered", async ({ page }) => {
    using _ = expectNoPageError(page);

    for (const [locale, slug] of [
      ["en", "hello"],
      ["en", "world"],
      ["fr", "hello"],
      ["fr", "world"],
    ]) {
      await page.goto(f.url(`/${locale}/blog/${slug}`));
      await waitForHydration(page);

      await expect(testId(page, "locale-detail-locale")).toContainText(locale);
      await expect(testId(page, "locale-detail-title")).toContainText(slug);
      await expect(testId(page, "locale-detail-content")).toContainText(
        `content-${locale}-${slug}`,
      );
    }
  });
});

// -- Passthrough (unknown locale/slug, live render) --------------------------
// Passthrough() wraps the Prerender def with a live handler. Unknown combos render live.

test.describe("prerender locale params passthrough (production build)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("unknown locale+slug renders live via passthrough", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/es/blog/unknown"));
    await waitForHydration(page);

    await expect(testId(page, "locale-detail-title")).toContainText("unknown");
    await expect(testId(page, "locale-detail-locale")).toContainText("es");
  });

  test("ctx.build is false for passthrough live render", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/es/blog/unknown"));
    await waitForHydration(page);

    await expect(testId(page, "locale-detail-build")).toContainText("false");
  });

  test("layout gets handler data in passthrough live render", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/es/blog/unknown"));
    await waitForHydration(page);

    await expect(testId(page, "locale-layout-content")).toContainText(
      "content-es-unknown",
    );
  });

  test("ctx.reverse auto-fills locale in passthrough render", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/es/blog/unknown"));
    await waitForHydration(page);

    await expect(testId(page, "locale-detail-list-url")).toContainText(
      "/es/blog",
    );
  });
});
