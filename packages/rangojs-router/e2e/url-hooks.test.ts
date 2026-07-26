import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId, goBack } from "./helper";

// ============================================================================
// setSearchParams (the useSearchParams tuple setter) — shared spec, invoked
// from BOTH the dev and (production) describes below.
// ============================================================================

function setSearchParamsTests(f: ReturnType<typeof useFixture>) {
  test("setSearchParams replaces the whole search string and pushes", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/hook-tests/url-hooks/test?q=react&page=2"));
    await waitForHydration(page);
    await expect(testId(page, "search-q")).toContainText("q:react");

    await testId(page, "set-search-replace-all").click();

    // Wholesale replace (RR semantics): page is GONE, not merged.
    await expect(testId(page, "search-output")).toContainText(
      "search:q=vue&sort=asc",
    );
    await expect(testId(page, "search-page")).toContainText("page:none");
    // Same-route write: pathname untouched.
    await expect(testId(page, "pathname-output")).toContainText(
      "pathname:/hook-tests/url-hooks/test",
    );

    // Default is push: Back restores the previous search state.
    await goBack(page);
    await expect(testId(page, "search-q")).toContainText("q:react");
    await expect(testId(page, "search-page")).toContainText("page:2");
  });

  test("setSearchParams functional form merges with current params", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/hook-tests/url-hooks/test?q=react&page=2"));
    await waitForHydration(page);
    await expect(testId(page, "search-page")).toContainText("page:2");

    await testId(page, "set-search-merge").click();

    // prev is the live params: q survives, page is overwritten.
    await expect(testId(page, "search-q")).toContainText("q:react");
    await expect(testId(page, "search-page")).toContainText("page:9");
  });

  test("setSearchParams replace:true rewrites the entry instead of pushing", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    // Entry A.
    await page.goto(f.url("/hook-tests/url-hooks/test?q=first"));
    await waitForHydration(page);
    await expect(testId(page, "search-q")).toContainText("q:first");

    // Entry B (push).
    await testId(page, "push-with-search").click();
    await expect(testId(page, "search-q")).toContainText("q:react");

    // Replace B in place.
    await testId(page, "set-search-history-replace").click();
    await expect(testId(page, "search-q")).toContainText("q:replaced");

    // Back skips the replaced entry and lands on A.
    await goBack(page);
    await expect(testId(page, "search-q")).toContainText("q:first");
  });

  test("setSearchParams with an empty init clears the search string", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/hook-tests/url-hooks/test?q=react&page=2"));
    await waitForHydration(page);

    await testId(page, "set-search-clear").click();

    await expect(testId(page, "search-output")).toHaveText("search:");
    await expect(page).toHaveURL(f.url("/hook-tests/url-hooks/test"));
  });
}

// ============================================================================
// useParams, usePathname, useSearchParams - Dev mode
// ============================================================================

test.describe("URL hooks", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  setSearchParamsTests(f);

  // ---------- useParams ----------

  test("useParams returns correct params on initial render", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/url-hooks/hello"));
    await waitForHydration(page);

    await expect(testId(page, "params-slug")).toContainText("slug:hello");
    await expect(testId(page, "params-id")).toContainText("id:none");
    await expect(testId(page, "params-output")).toContainText(
      'params:{"slug":"hello"}',
    );
  });

  test("useParams updates on push navigation", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/hook-tests/url-hooks/hello"));
    await waitForHydration(page);

    await expect(testId(page, "params-slug")).toContainText("slug:hello");

    // Push to different slug
    await testId(page, "push-slug-world").click();
    await expect(testId(page, "params-slug")).toContainText("slug:world", {
      timeout: 5000,
    });
    await expect(testId(page, "params-output")).toContainText(
      'params:{"slug":"world"}',
    );
  });

  test("useParams returns multiple params on nested route", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/url-hooks/hello/42"));
    await waitForHydration(page);

    await expect(testId(page, "params-slug")).toContainText("slug:hello");
    await expect(testId(page, "params-id")).toContainText("id:42");
    await expect(testId(page, "params-output")).toContainText(
      'params:{"slug":"hello","id":"42"}',
    );
  });

  test("useParams updates on push to nested route", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/hook-tests/url-hooks/hello"));
    await waitForHydration(page);

    await expect(testId(page, "params-id")).toContainText("id:none");

    // Push to nested route with two params
    await testId(page, "push-nested").click();
    await expect(testId(page, "params-slug")).toContainText("slug:hello", {
      timeout: 5000,
    });
    await expect(testId(page, "params-id")).toContainText("id:42");
  });

  test("useParams selector returns specific param", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/url-hooks/hello"));
    await waitForHydration(page);

    await expect(testId(page, "params-selector-slug")).toContainText(
      "selector-slug:hello",
    );
  });

  // ---------- usePathname ----------

  test("usePathname returns correct pathname on initial render", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/url-hooks/hello"));
    await waitForHydration(page);

    await expect(testId(page, "pathname-output")).toContainText(
      "pathname:/hook-tests/url-hooks/hello",
    );
  });

  test("usePathname updates on push navigation", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/hook-tests/url-hooks/hello"));
    await waitForHydration(page);

    await testId(page, "push-slug-world").click();
    await expect(testId(page, "pathname-output")).toContainText(
      "pathname:/hook-tests/url-hooks/world",
      { timeout: 5000 },
    );
  });

  test("usePathname does not include search params", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/url-hooks/hello?q=test&page=2"));
    await waitForHydration(page);

    await expect(testId(page, "pathname-output")).toContainText(
      "pathname:/hook-tests/url-hooks/hello",
    );
    // Verify search params are separate
    await expect(testId(page, "search-q")).toContainText("q:test");
  });

  // ---------- useSearchParams ----------

  test("useSearchParams returns correct params on initial render", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/url-hooks/hello?q=react&page=2"));
    await waitForHydration(page);

    await expect(testId(page, "search-q")).toContainText("q:react");
    await expect(testId(page, "search-page")).toContainText("page:2");
  });

  test("useSearchParams returns empty when no query string", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/url-hooks/hello"));
    await waitForHydration(page);

    await expect(testId(page, "search-q")).toContainText("q:none");
    await expect(testId(page, "search-page")).toContainText("page:none");
    await expect(testId(page, "search-output")).toContainText("search:");
  });

  test("useSearchParams updates on navigation with search params", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/hook-tests/url-hooks/hello"));
    await waitForHydration(page);

    await expect(testId(page, "search-q")).toContainText("q:none");

    // Push with search params
    await testId(page, "push-with-search").click();
    await expect(testId(page, "search-q")).toContainText("q:react", {
      timeout: 5000,
    });
    await expect(testId(page, "search-page")).toContainText("page:2");
  });

  // ---------- Cross-hook consistency ----------

  test("all hooks update together on navigation", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/hook-tests/url-hooks/hello"));
    await waitForHydration(page);

    // Verify initial state
    await expect(testId(page, "params-slug")).toContainText("slug:hello");
    await expect(testId(page, "pathname-output")).toContainText(
      "pathname:/hook-tests/url-hooks/hello",
    );
    await expect(testId(page, "search-q")).toContainText("q:none");

    // Push with params + search
    await testId(page, "push-with-search").click();

    // All should update together
    await expect(testId(page, "params-slug")).toContainText("slug:test", {
      timeout: 5000,
    });
    await expect(testId(page, "pathname-output")).toContainText(
      "pathname:/hook-tests/url-hooks/test",
    );
    await expect(testId(page, "search-q")).toContainText("q:react");
    await expect(testId(page, "search-page")).toContainText("page:2");
  });

  // ---------- Navigation scenarios ----------

  test("back/forward navigation restores correct hook state", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/url-hooks/first"));
    await waitForHydration(page);

    await expect(testId(page, "params-slug")).toContainText("slug:first");

    // Push to second
    await testId(page, "push-slug-world").click();
    await expect(testId(page, "params-slug")).toContainText("slug:world", {
      timeout: 5000,
    });
    await expect(testId(page, "pathname-output")).toContainText(
      "pathname:/hook-tests/url-hooks/world",
    );

    // Go back
    await goBack(page);
    await expect(testId(page, "params-slug")).toContainText("slug:first", {
      timeout: 5000,
    });
    await expect(testId(page, "pathname-output")).toContainText(
      "pathname:/hook-tests/url-hooks/first",
    );
  });

  test("replace navigation updates hooks without adding history", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/hook-tests/url-hooks/hello"));
    await waitForHydration(page);

    await testId(page, "replace-slug-replaced").click();
    await expect(testId(page, "params-slug")).toContainText("slug:replaced", {
      timeout: 5000,
    });
    await expect(testId(page, "pathname-output")).toContainText(
      "pathname:/hook-tests/url-hooks/replaced",
    );
  });
});

// ============================================================================
// useParams, usePathname, useSearchParams - Production mode
// ============================================================================

test.describe("URL hooks (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  setSearchParamsTests(f);

  // ---------- useParams ----------

  test("useParams returns correct params on initial render", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/url-hooks/hello"));
    await waitForHydration(page);

    await expect(testId(page, "params-slug")).toContainText("slug:hello");
    await expect(testId(page, "params-id")).toContainText("id:none");
    await expect(testId(page, "params-output")).toContainText(
      'params:{"slug":"hello"}',
    );
  });

  test("useParams updates on push navigation", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/hook-tests/url-hooks/hello"));
    await waitForHydration(page);

    await testId(page, "push-slug-world").click();
    await expect(testId(page, "params-slug")).toContainText("slug:world", {
      timeout: 5000,
    });
  });

  test("useParams returns multiple params on nested route", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/url-hooks/hello/42"));
    await waitForHydration(page);

    await expect(testId(page, "params-slug")).toContainText("slug:hello");
    await expect(testId(page, "params-id")).toContainText("id:42");
  });

  test("useParams selector returns specific param", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/url-hooks/hello"));
    await waitForHydration(page);

    await expect(testId(page, "params-selector-slug")).toContainText(
      "selector-slug:hello",
    );
  });

  // ---------- usePathname ----------

  test("usePathname returns correct pathname on initial render", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/url-hooks/hello"));
    await waitForHydration(page);

    await expect(testId(page, "pathname-output")).toContainText(
      "pathname:/hook-tests/url-hooks/hello",
    );
  });

  test("usePathname updates on push and does not include search params", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/hook-tests/url-hooks/hello"));
    await waitForHydration(page);

    await testId(page, "push-with-search").click();
    await expect(testId(page, "pathname-output")).toContainText(
      "pathname:/hook-tests/url-hooks/test",
      { timeout: 5000 },
    );
    // Search params should be separate
    await expect(testId(page, "search-q")).toContainText("q:react");
  });

  // ---------- useSearchParams ----------

  test("useSearchParams returns correct params on initial render", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/url-hooks/hello?q=react&page=2"));
    await waitForHydration(page);

    await expect(testId(page, "search-q")).toContainText("q:react");
    await expect(testId(page, "search-page")).toContainText("page:2");
  });

  test("useSearchParams returns empty when no query string", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/url-hooks/hello"));
    await waitForHydration(page);

    await expect(testId(page, "search-q")).toContainText("q:none");
    await expect(testId(page, "search-page")).toContainText("page:none");
  });

  test("useSearchParams updates on navigation with search params", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/hook-tests/url-hooks/hello"));
    await waitForHydration(page);

    await testId(page, "push-with-search").click();
    await expect(testId(page, "search-q")).toContainText("q:react", {
      timeout: 5000,
    });
    await expect(testId(page, "search-page")).toContainText("page:2");
  });

  // ---------- Cross-hook consistency ----------

  test("all hooks update together on navigation", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/hook-tests/url-hooks/hello"));
    await waitForHydration(page);

    await testId(page, "push-with-search").click();

    await expect(testId(page, "params-slug")).toContainText("slug:test", {
      timeout: 5000,
    });
    await expect(testId(page, "pathname-output")).toContainText(
      "pathname:/hook-tests/url-hooks/test",
    );
    await expect(testId(page, "search-q")).toContainText("q:react");
  });

  // ---------- Navigation scenarios ----------

  test("back/forward navigation restores correct hook state", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/hook-tests/url-hooks/first"));
    await waitForHydration(page);

    await testId(page, "push-slug-world").click();
    await expect(testId(page, "params-slug")).toContainText("slug:world", {
      timeout: 5000,
    });

    await goBack(page);
    await expect(testId(page, "params-slug")).toContainText("slug:first", {
      timeout: 5000,
    });
    await expect(testId(page, "pathname-output")).toContainText(
      "pathname:/hook-tests/url-hooks/first",
    );
  });

  test("replace navigation updates hooks", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/hook-tests/url-hooks/hello"));
    await waitForHydration(page);

    await testId(page, "replace-slug-replaced").click();
    await expect(testId(page, "params-slug")).toContainText("slug:replaced", {
      timeout: 5000,
    });
    await expect(testId(page, "pathname-output")).toContainText(
      "pathname:/hook-tests/url-hooks/replaced",
    );
  });
});
