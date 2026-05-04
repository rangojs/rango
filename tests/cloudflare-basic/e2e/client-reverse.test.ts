import { type Page, expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * Minimal cloudflare-basic coverage for the client `useReverse(routes)` hook.
 * Verifies: dot-prefix resolution, mount-relative joining, autofill from
 * `useParams()`, and explicit-override on the Cloudflare preset.
 */

async function assertReverseSurface(page: Page, opts: { tenantId: string }) {
  const { tenantId } = opts;
  const base = `/cr/${tenantId}`;

  await expect(testId(page, "cr-cf-nav")).toBeVisible();
  await expect(testId(page, "cr-cf-tenant")).toHaveText(tenantId);
  await expect(testId(page, "cr-cf-index")).toHaveText(base);
  await expect(testId(page, "cr-cf-post-explicit")).toHaveText(
    `${base}/posts/p1`,
  );
  await expect(testId(page, "cr-cf-post-autofill")).toHaveText(
    `${base}/posts/p2`,
  );
  await expect(testId(page, "cr-cf-post-override")).toHaveText(
    `/cr/other/posts/p2`,
  );
}

function describeForMode(label: string, mode: "dev" | "build") {
  test.describe(label, () => {
    const f = useFixture({ root: ".", mode });

    test("resolves on initial SSR + hydration", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/cr/acme"));
      const ssrIndex = await testId(page, "cr-cf-index").textContent();
      expect(ssrIndex).toBe("/cr/acme");

      await waitForHydration(page);
      await assertReverseSurface(page, { tenantId: "acme" });
    });

    test("autofill follows soft navigation", async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/cr/acme"));
      await waitForHydration(page);

      await testId(page, "cr-cf-link").click();
      await expect(page).toHaveURL(/\/cr\/zeta$/);
      await assertReverseSurface(page, { tenantId: "zeta" });
    });
  });
}

describeForMode("client-reverse-cf (dev)", "dev");
describeForMode("client-reverse-cf (production)", "build");
