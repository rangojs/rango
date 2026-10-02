import test, { expect } from "@playwright/test";
import {
  expectClientLinkNavigation,
  fetchDocument,
  headChunkScripts,
} from "@shared/e2e";
import { useFixture } from "./fixture";
import { expectNoPageError, waitForHydration } from "./helper";

/**
 * rango({ headScripts: { mode: "preinit", fetchPriority: "low" } }): head
 * chunk scripts carry fetchpriority="low". Runs only under
 * playwright.priority-low.config.ts (RANGO_E2E_HEAD_SCRIPTS=priority-low); the
 * default ("auto", no attribute) is covered by head-script-preinit.test.ts.
 */

test.describe("head-script-priority-low", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });

  test("no head chunk scripts in dev", async () => {
    // plugin-rsc reports no JS deps per client reference in dev.
    expect(headChunkScripts(await fetchDocument(f.url("/")))).toEqual([]);
  });

  test("a client Link navigates after hydration", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/"));
    await waitForHydration(page);
    await expectClientLinkNavigation(
      page,
      "product-link-product-a",
      "/product/product-a",
    );
  });
});

test.describe("head-script-priority-low (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });

  test('head chunk scripts carry fetchpriority="low"', async () => {
    const scripts = headChunkScripts(await fetchDocument(f.url("/")));
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) {
      expect(tag).toMatch(/\bfetchpriority="low"/i);
    }
  });

  test("a client Link navigates after hydration", async ({ page }) => {
    using _ = expectNoPageError(page);
    await page.goto(f.url("/"));
    await waitForHydration(page);
    await expectClientLinkNavigation(
      page,
      "product-link-product-a",
      "/product/product-a",
    );
  });
});
