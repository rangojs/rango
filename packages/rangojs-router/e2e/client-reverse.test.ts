import { type Page, expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * Tests for the client-side `useReverse(routes)` hook.
 *
 * The same `clientReversePatterns` is mounted twice in the test app —
 * `/cr/a/:tenantId` (named `crA`) and `/cr/b/:tenantId` (named `crB`) — so
 * a single component proves it resolves against the surrounding
 * `useMount()` rather than a fixed include scope.
 */

async function assertNavSurface(
  page: Page,
  opts: { mountPrefix: string; tenantId: string },
) {
  const { mountPrefix, tenantId } = opts;
  const base = `${mountPrefix}/${tenantId}`;

  await expect(testId(page, "client-reverse-nav")).toBeVisible();
  // useMount() returns the include's URL pattern (e.g. "/cr/a/:tenantId"),
  // not the resolved URL — the resolved URL comes from the reverse outputs
  // below, which substitute :tenantId from useParams() autofill.
  await expect(testId(page, "cr-mount")).toHaveText(`${mountPrefix}/:tenantId`);
  await expect(testId(page, "cr-tenant")).toHaveText(tenantId);

  // index pattern "/" under non-root mount must collapse to the mount with
  // no trailing slash, matching ctx.reverse(".index") on the server.
  await expect(testId(page, "cr-index")).toHaveText(base);

  // explicit params
  await expect(testId(page, "cr-detail-explicit")).toHaveText(
    `${base}/posts/p1`,
  );

  // tenantId is auto-filled from useParams() on top of explicit postId
  await expect(testId(page, "cr-detail-autofill-tenant")).toHaveText(
    `${base}/posts/p2`,
  );

  // explicit tenantId in the params overrides the auto-fill
  await expect(testId(page, "cr-detail-override-tenant")).toHaveText(
    `${mountPrefix}/other/posts/p2`,
  );

  // optional param omitted -> trailing :section? collapses
  await expect(testId(page, "cr-optional-omitted")).toHaveText(
    `${base}/items/i1`,
  );
  await expect(testId(page, "cr-optional-given")).toHaveText(
    `${base}/items/i1/s1`,
  );
  // empty string is treated as omitted, same as undefined
  await expect(testId(page, "cr-optional-empty-string")).toHaveText(
    `${base}/items/i1`,
  );

  // constrained param substitutes by name only — constraint syntax is stripped
  await expect(testId(page, "cr-locale")).toHaveText(`${base}/locale/en`);

  // search schema route — params object can be empty, search is appended
  await expect(testId(page, "cr-search")).toHaveText(
    `${base}/search?q=hello%20world&page=2`,
  );

  // nested key (".nested.index") resolves against the local map
  await expect(testId(page, "cr-nested-index")).toHaveText(`${base}/nested`);

  // error messages
  await expect(testId(page, "cr-unknown")).toHaveText(
    `ERROR: Unknown local route: ".not-a-route"`,
  );
  await expect(testId(page, "cr-missing-param")).toHaveText(
    `ERROR: Missing param "postId" for route ".detail"`,
  );
  await expect(testId(page, "cr-no-dot")).toHaveText(
    `ERROR: Local route names must start with ".": "index"`,
  );
}

function describeForMode(label: string, mode: "dev" | "build") {
  test.describe(label, () => {
    const f = useFixture({ root: "./e2e/test-app", mode });

    test("resolves against /cr/a mount on initial SSR + hydration", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // Capture the SSR-rendered text BEFORE hydration to verify parity.
      // The cr-index span is the cleanest probe (its text is the resolved URL).
      await page.goto(f.url("/cr/a/acme"));
      const ssrIndexHref = await testId(page, "cr-index").textContent();
      expect(ssrIndexHref).toBe("/cr/a/acme");

      await waitForHydration(page);
      await assertNavSurface(page, {
        mountPrefix: "/cr/a",
        tenantId: "acme",
      });
    });

    test("resolves against /cr/b mount — same component, different mount", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/cr/b/acme"));
      await waitForHydration(page);
      await assertNavSurface(page, {
        mountPrefix: "/cr/b",
        tenantId: "acme",
      });
    });

    test("autofill follows useParams() across detail page", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/cr/a/acme/posts/p1"));
      await waitForHydration(page);

      await expect(testId(page, "cr-tenant")).toHaveText("acme");
      // .index reverse from a detail page still autofills tenantId
      await expect(testId(page, "cr-index")).toHaveText("/cr/a/acme");
      await expect(testId(page, "cr-detail-autofill-tenant")).toHaveText(
        "/cr/a/acme/posts/p2",
      );
    });

    test("soft navigation updates autofill", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/cr/a/acme"));
      await waitForHydration(page);

      // Click into the detail page (still under /cr/a/acme)
      await testId(page, "cr-link-go-detail").click();
      await expect(page).toHaveURL(/\/cr\/a\/acme\/posts\/p1$/);
      await expect(testId(page, "cr-tenant")).toHaveText("acme");

      // Soft-navigate to a different tenant. autofill should now use "zeta".
      await testId(page, "cr-link-switch-tenant").click();
      await expect(page).toHaveURL(/\/cr\/a\/zeta$/);
      await expect(testId(page, "cr-tenant")).toHaveText("zeta");
      await expect(testId(page, "cr-detail-autofill-tenant")).toHaveText(
        "/cr/a/zeta/posts/p2",
      );
      await expect(testId(page, "cr-index")).toHaveText("/cr/a/zeta");
    });

    test("resolves from WITHIN a nested include — mount accumulates both levels", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      // /cr/a/:tenantId/nested is a 2-level include: clientReversePatterns
      // (mounted at /cr/a/:tenantId) includes clientReverseNestedPatterns at
      // "/nested", which renders ClientReverseNav too. This pins that
      // useMount() accumulates the FULL nested path (not just "/nested") and
      // that useReverse() resolves every shape against it.
      await page.goto(f.url("/cr/a/acme/nested"));

      // SSR parity: the resolved index href is already correct pre-hydration.
      const ssrIndex = await testId(page, "cr-index").textContent();
      expect(ssrIndex).toBe("/cr/a/acme/nested");

      await waitForHydration(page);

      // useMount() is the accumulated 2-level mount PATTERN, not just "/nested".
      await expect(testId(page, "cr-mount")).toHaveText(
        "/cr/a/:tenantId/nested",
      );
      await expect(testId(page, "cr-tenant")).toHaveText("acme");

      // ".index" "/" collapses onto the nested mount; :tenantId autofilled.
      await expect(testId(page, "cr-index")).toHaveText("/cr/a/acme/nested");

      // params + autofill resolve against the nested mount.
      await expect(testId(page, "cr-detail-explicit")).toHaveText(
        "/cr/a/acme/nested/posts/p1",
      );
      await expect(testId(page, "cr-detail-autofill-tenant")).toHaveText(
        "/cr/a/acme/nested/posts/p2",
      );
      await expect(testId(page, "cr-optional-omitted")).toHaveText(
        "/cr/a/acme/nested/items/i1",
      );
      await expect(testId(page, "cr-search")).toHaveText(
        "/cr/a/acme/nested/search?q=hello%20world&page=2",
      );

      // ".nested.index" resolves to ".../nested/nested" here BY DESIGN: this
      // component is bound to the OUTER module's map (whose ".nested.index"
      // pattern is "/nested") yet renders AT the nested mount, so joinMount
      // prepends the nested mount. useReverse couples a static module map with
      // the runtime useMount() — they line up only when a component renders
      // within the module its map describes. This asserts that invariant.
      await expect(testId(page, "cr-nested-index")).toHaveText(
        "/cr/a/acme/nested/nested",
      );
    });
  });
}

describeForMode("client-reverse (dev)", "dev");
describeForMode("client-reverse (production)", "build");
