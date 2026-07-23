import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * Regression: a fetchable loader reachable ONLY through a client component —
 * never registered via loader(), never imported by the worker entry or any
 * other server module — must resolve through the _rsc_loader endpoint in
 * production, not just in dev.
 *
 * The bug: a custom Cloudflare worker entry (src/worker.rsc.tsx) did not import
 * the loader manifest, so setLoaderImports() was never bundled into the worker.
 * At runtime lazyLoaderImports stayed null, the orphan loader's module never
 * executed, and the endpoint failed with a 500 ("No such module <hash>") from
 * the dev-only path-import fallback. Dev worked because it resolves loaders by
 * parsing the id into a file path — hence the production-only failure.
 *
 * /orphan-fetch renders OrphanFetchTest, whose load() call hits the endpoint.
 * This runs in BOTH dev and production against a real workerd runtime.
 */
function describeOrphanFetchable(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";
  test.describe(`orphan fetchable loader (${label})`, () => {
    const f = useFixture({ root: ".", mode });

    test("resolves a client-only fetchable loader via _rsc_loader", async ({
      page,
    }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url("/orphan-fetch"));
      await waitForHydration(page);

      await expect(testId(page, "orphan-fetch-test")).toBeVisible();
      await testId(page, "orphan-fetch-btn").click();

      await expect(testId(page, "orphan-fetch-data")).toBeVisible({
        timeout: 10000,
      });
      await expect(testId(page, "orphan-fetch-message")).toContainText(
        "Orphan fetchable loaded!",
      );
      await expect(testId(page, "orphan-fetch-id")).toContainText(
        "orphan-default",
      );
      await expect(testId(page, "orphan-fetch-error")).not.toBeVisible();
    });
  });
}

describeOrphanFetchable("dev");
describeOrphanFetchable("build");
