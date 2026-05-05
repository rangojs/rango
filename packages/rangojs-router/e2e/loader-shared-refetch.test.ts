import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * Regression test: when multiple components on the same page read the
 * same loader (via useLoader / useFetchLoader) and one of them calls
 * load() to refetch, every reading site must observe the new value.
 *
 * The /shared-refetch route renders three reads of SharedRefetchLoader
 * (a counter loader):
 *   - SharedRefetchLayout      (useLoader, owns the refetch button)
 *   - SharedRefetchPage        (useLoader, page-level read)
 *   - SharedRefetchSibling     (useFetchLoader, third read)
 *
 * Initial counts must match across all three. After clicking the
 * layout's refetch button, the layout's count must change AND the
 * other two reads must converge on the same new count.
 *
 * Today only the layout updates (per-hook local fetchedData), so the
 * page/sibling assertions fail. That failure is the regression guard.
 */

const PATH = "/shared-refetch";

async function readAllCounts(page: import("@playwright/test").Page) {
  const [layout, pageVal, sibling] = await Promise.all([
    testId(page, "shared-refetch-layout-value").textContent(),
    testId(page, "shared-refetch-page-value").textContent(),
    testId(page, "shared-refetch-sibling-value").textContent(),
  ]);
  return {
    layout: (layout ?? "").trim(),
    page: (pageVal ?? "").trim(),
    sibling: (sibling ?? "").trim(),
  };
}

function describeSharedRefetch(label: string, mode: "dev" | "build") {
  test.describe(`shared-refetch (${label})`, () => {
    const f = useFixture({
      root: "./e2e/test-app",
      mode,
      isolatedServer: mode === "dev" ? true : undefined,
    });

    test.setTimeout(30000);

    test("params-stay-local: parameterized loads keep independent results", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/shared-refetch-params"));
      await waitForHydration(page);

      // Both widgets start with "—" — no contextData, no fetched data yet.
      await expect(testId(page, "shared-refetch-param-A-tag")).toHaveText("—");
      await expect(testId(page, "shared-refetch-param-B-tag")).toHaveText("—");

      // A fetches with tag="alpha".
      await testId(page, "shared-refetch-param-A-load-btn").click();
      await expect(testId(page, "shared-refetch-param-A-tag")).toHaveText(
        "alpha",
      );
      // B must NOT have absorbed A's result through the shared store —
      // parameterized loads stay local.
      await expect(testId(page, "shared-refetch-param-B-tag")).toHaveText("—");

      // B fetches with tag="beta". A keeps "alpha".
      await testId(page, "shared-refetch-param-B-load-btn").click();
      await expect(testId(page, "shared-refetch-param-B-tag")).toHaveText(
        "beta",
      );
      await expect(testId(page, "shared-refetch-param-A-tag")).toHaveText(
        "alpha",
      );
    });

    test("error: throwOnError: true originator throws, sibling exposes error without throwing", async ({
      page,
    }) => {
      // Page-error guard intentionally omitted — a thrown render is
      // expected from the originator and would trip the assertion.

      await page.goto(f.url("/shared-refetch-error"));
      await waitForHydration(page);

      await expect(testId(page, "shared-refetch-error-page")).toBeVisible();
      await expect(testId(page, "shared-refetch-err-A-error")).toHaveText("—");
      await expect(testId(page, "shared-refetch-err-B-error")).toHaveText("—");

      // A triggers a failing load(); A's render throws and its boundary
      // catches it. We don't assert the message content (production
      // sanitizes server errors to a generic "An error occurred"); the
      // fact that the fallback rendered at all proves the throw happened.
      await testId(page, "shared-refetch-err-A-load-btn").click();
      await expect(testId(page, "shared-refetch-err-A-fallback")).toBeVisible();

      // B is still mounted — its render did NOT throw — and exposes the
      // shared error via its `error` span. We assert the span moved off
      // its initial "—" placeholder rather than checking the message.
      await expect(testId(page, "shared-refetch-err-B-fallback")).toHaveCount(
        0,
      );
      await expect(testId(page, "shared-refetch-err-B")).toBeVisible();
      await expect(testId(page, "shared-refetch-err-B-error")).not.toHaveText(
        "—",
      );
    });

    test("error mixed: originator throwOnError: false stays mounted, sibling throwOnError: true does not throw", async ({
      page,
    }) => {
      // No throws are expected in this scenario, so the page-error guard
      // is on. If either widget render-throws we want the test to fail.
      using _ = expectNoPageError(page);

      await page.goto(f.url("/shared-refetch-error-mixed"));
      await waitForHydration(page);

      await expect(
        testId(page, "shared-refetch-error-mixed-page"),
      ).toBeVisible();
      await expect(testId(page, "shared-refetch-err-A-error")).toHaveText("—");
      await expect(testId(page, "shared-refetch-err-B-error")).toHaveText("—");

      // A clicks; A has throwOnError: false so the failure is captured
      // in A's `error` rather than thrown to its boundary. A's inner
      // stays mounted (no fallback). The sibling B has throwOnError:
      // true but did NOT originate the request, so the throw guard
      // skips for B and B also stays mounted with `error` exposed.
      await testId(page, "shared-refetch-err-A-load-btn").click();

      await expect(testId(page, "shared-refetch-err-A-fallback")).toHaveCount(
        0,
      );
      await expect(testId(page, "shared-refetch-err-B-fallback")).toHaveCount(
        0,
      );

      await expect(testId(page, "shared-refetch-err-A-error")).not.toHaveText(
        "—",
      );
      await expect(testId(page, "shared-refetch-err-B-error")).not.toHaveText(
        "—",
      );
    });

    test("multiple reads of one loader all update on a single load() call", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url(PATH));
      await waitForHydration(page);

      // All three reads should be visible once hydration finishes.
      await expect(testId(page, "shared-refetch-layout")).toBeVisible();
      await expect(testId(page, "shared-refetch-page")).toBeVisible();
      await expect(testId(page, "shared-refetch-sibling")).toBeVisible();

      // Initial render: all three reads are seeded from the same
      // server-provided loaderData, so they must agree.
      const initial = await readAllCounts(page);
      expect(initial.layout).toBeTruthy();
      expect(initial.layout).toBe(initial.page);
      expect(initial.layout).toBe(initial.sibling);

      // Trigger refetch from the layout. After load() resolves, the
      // layout MUST display a different count (otherwise the test
      // proves nothing about propagation).
      await testId(page, "shared-refetch-layout-load-btn").click();
      await expect
        .poll(() => testId(page, "shared-refetch-layout-value").textContent())
        .not.toBe(initial.layout);

      // The actual regression assertion: every read site agrees with
      // the layout on the post-refetch value. Today the page and
      // sibling reads stay on the initial count because each hook
      // instance owns its own fetchedData, so this fails.
      await expect
        .poll(async () => readAllCounts(page))
        .toEqual({
          layout: expect.any(String),
          page: expect.any(String),
          sibling: expect.any(String),
        });
      const after = await readAllCounts(page);
      expect(after.layout).not.toBe(initial.layout);
      expect(after.page).toBe(after.layout);
      expect(after.sibling).toBe(after.layout);
    });
  });
}

describeSharedRefetch("dev", "dev");
describeSharedRefetch("production", "build");
