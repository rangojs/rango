import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

/**
 * Regression: Static() / Prerender() SSR stub crash in production.
 *
 * The production SSR build bundles the RSC entry chunk and resolves
 * @rangojs/router to the SSR entry (index.ts). Previously Static() and
 * Prerender() were error-throwing stubs there, crashing the RSC entry
 * at module-evaluation time and breaking all production routes that
 * loaded the chunk containing colocated Static/Prerender handlers.
 *
 * Fix: SSR stubs now return lightweight { __brand, $$id } objects
 * (matching createLoader's pattern) instead of throwing.
 */

test.describe("Static/Prerender SSR stub regression (dev)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });

  test("colocated Static handler renders", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/colocated-lp/static"));
    await waitForHydration(page);
    await expect(page.getByTestId("colocated-static-title")).toHaveText(
      "Colocated Static",
    );
  });

  test("colocated Prerender handler renders", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/colocated-lp/prerender"));
    await waitForHydration(page);
    await expect(page.getByTestId("colocated-prerender-title")).toHaveText(
      "Colocated Prerender",
    );
  });
});

test.describe("Static/Prerender SSR stub regression (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });

  test("colocated Static handler renders without RSC entry crash", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/colocated-lp/static"));
    await waitForHydration(page);
    await expect(page.getByTestId("colocated-static-title")).toHaveText(
      "Colocated Static",
    );
  });

  test("colocated Prerender handler renders without RSC entry crash", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/colocated-lp/prerender"));
    await waitForHydration(page);
    await expect(page.getByTestId("colocated-prerender-title")).toHaveText(
      "Colocated Prerender",
    );
  });
});
