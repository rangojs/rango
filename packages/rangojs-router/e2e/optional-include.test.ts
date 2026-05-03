import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * Regression coverage for `include("/:locale?", routes)` shapes.
 *
 * The underlying bug lives in `compilePattern()` — a pattern made entirely
 * of optional segments (e.g. `/:locale?`) does not match a bare `/`. The
 * unit suite in `src/router/__tests__/pattern-matching.test.ts`
 * ("all-optional patterns (no static tail)") exercises that exact regex
 * shape and is the binding regression test.
 *
 * The e2e fixtures here mount the include under a static prefix
 * (`/oi`, `/coi`) so they coexist with the test-app's HomePage at `/`
 * without route collisions. With a static prefix, the joined pattern is
 * `^/oi(?:/X)?$` which already matches `/oi` even before the fix — these
 * tests therefore serve as API-level smoke coverage proving that the
 * include + optional + child-path join still produces the expected URL
 * surface in dev and in production builds.
 */

const formatLocale = (locale: string): string =>
  locale === "" ? "(none)" : locale;

const expectLocaleText = async (
  page: Page,
  testIdName: string,
  locale: string,
): Promise<void> => {
  await expect(testId(page, testIdName)).toHaveText(
    `locale=${formatLocale(locale)}`,
  );
};

const expectIndex = async (page: Page, locale: string): Promise<void> => {
  await expect(testId(page, "optional-include-index")).toBeVisible();
  await expectLocaleText(page, "optional-include-index-locale", locale);
};

const expectCategory = async (
  page: Page,
  locale: string,
  slug: string,
): Promise<void> => {
  await expect(testId(page, "optional-include-category")).toBeVisible();
  await expect(testId(page, "optional-include-category-title")).toHaveText(
    `Category: ${slug}`,
  );
  await expectLocaleText(page, "optional-include-category-locale", locale);
};

const expectConstrainedIndex = async (
  page: Page,
  locale: string,
): Promise<void> => {
  await expect(
    testId(page, "constrained-optional-include-index"),
  ).toBeVisible();
  await expectLocaleText(
    page,
    "constrained-optional-include-index-locale",
    locale,
  );
};

test.describe('include("/oi/:locale?", optionalIncludePatterns) (dev)', () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  test.setTimeout(30_000);

  test("index renders without locale", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/oi"));
    await waitForHydration(page);
    await expectIndex(page, "");
  });

  test("index renders with locale", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/oi/en"));
    await waitForHydration(page);
    await expectIndex(page, "en");
  });

  test("category renders without locale", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/oi/c/breads"));
    await waitForHydration(page);
    await expectCategory(page, "", "breads");
  });

  test("category renders with locale", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/oi/en/c/breads"));
    await waitForHydration(page);
    await expectCategory(page, "en", "breads");
  });
});

test.describe('include("/oi/:locale?", optionalIncludePatterns) (production)', () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  test.setTimeout(120_000);

  test("index renders without locale", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/oi"));
    await waitForHydration(page);
    await expectIndex(page, "");
  });

  test("index renders with locale", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/oi/en"));
    await waitForHydration(page);
    await expectIndex(page, "en");
  });

  test("category renders without locale", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/oi/c/breads"));
    await waitForHydration(page);
    await expectCategory(page, "", "breads");
  });

  test("category renders with locale", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/oi/en/c/breads"));
    await waitForHydration(page);
    await expectCategory(page, "en", "breads");
  });
});

test.describe('include("/coi/:locale(en|gb)?", constrainedOptionalIncludePatterns) (dev)', () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  test.setTimeout(30_000);

  test("matches without locale", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/coi"));
    await waitForHydration(page);
    await expectConstrainedIndex(page, "");
  });

  test("matches allowed locales", async ({ page }) => {
    using _ = expectNoPageError(page);
    for (const locale of ["en", "gb"]) {
      await page.goto(f.url(`/coi/${locale}`));
      await waitForHydration(page);
      await expectConstrainedIndex(page, locale);
    }
  });

  test("rejects locale outside the constraint", async ({ page }) => {
    const response = await page.request.get(f.url("/coi/fr"));
    expect(response.status()).toBe(404);
  });
});

test.describe('include("/coi/:locale(en|gb)?", constrainedOptionalIncludePatterns) (production)', () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  test.setTimeout(120_000);

  test("matches without locale", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/coi"));
    await waitForHydration(page);
    await expectConstrainedIndex(page, "");
  });

  test("matches allowed locales", async ({ page }) => {
    using _ = expectNoPageError(page);
    for (const locale of ["en", "gb"]) {
      await page.goto(f.url(`/coi/${locale}`));
      await waitForHydration(page);
      await expectConstrainedIndex(page, locale);
    }
  });

  test("rejects locale outside the constraint", async ({ page }) => {
    const response = await page.request.get(f.url("/coi/fr"));
    expect(response.status()).toBe(404);
  });
});
