import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";
import fs from "node:fs";
import path from "node:path";

/**
 * HMR tests for pre-rendered and static content.
 *
 * Verifies that editing a Prerender() or Static() handler — and
 * components they import — applies the change via HMR in dev mode.
 *
 * LOCAL ONLY — skipped on CI because file-watcher flakiness on
 * virtualized FS makes HMR timing unreliable.
 */
test.skip(!!process.env.CI, "local-only HMR test — skipped on CI");

test.describe.serial("prerender-hmr", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.setTimeout(30_000);

  // -- Prerender() handler file test (contains urls()) --------------------

  const prerenderPath = path.resolve("./e2e/test-app/src/urls/prerender.tsx");
  let prerenderOriginal: string;

  test.beforeAll(async () => {
    prerenderOriginal = fs.readFileSync(prerenderPath, "utf-8");
  });

  test.afterAll(async () => {
    fs.writeFileSync(prerenderPath, prerenderOriginal);
    await new Promise((r) => setTimeout(r, 1000));
  });

  test("editing Prerender() handler content updates via HMR", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/docs"));
    await waitForHydration(page);

    await expect(testId(page, "docs-content")).toHaveText(
      "This is pre-rendered documentation content.",
    );

    const modified = prerenderOriginal.replace(
      "This is pre-rendered documentation content.",
      "HMR updated pre-rendered content.",
    );
    fs.writeFileSync(prerenderPath, modified);

    await expect(testId(page, "docs-content")).toHaveText(
      "HMR updated pre-rendered content.",
      { timeout: 15000 },
    );
  });

  test("editing Static() handler content updates via HMR", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/static-page"));
    await waitForHydration(page);

    await expect(testId(page, "static-page-content")).toHaveText(
      "This is a statically pre-rendered page.",
    );

    const modified = prerenderOriginal.replace(
      "This is a statically pre-rendered page.",
      "HMR updated static content.",
    );
    fs.writeFileSync(prerenderPath, modified);

    await expect(testId(page, "static-page-content")).toHaveText(
      "HMR updated static content.",
      { timeout: 15000 },
    );
  });

  // -- Imported component file test (no urls()) --------------------------
  // This is the key regression test: editing a component imported by a
  // Prerender route must also trigger a visible HMR update. Before the fix,
  // the dev prerender store served stale content because the RouterRegistry
  // snapshot wasn't refreshed for non-route file changes.

  const layoutPath = path.resolve(
    "./e2e/test-app/src/components/layouts/PrerenderComplexLayout.tsx",
  );
  let layoutOriginal: string;

  test.beforeAll(async () => {
    layoutOriginal = fs.readFileSync(layoutPath, "utf-8");
  });

  test.afterAll(async () => {
    fs.writeFileSync(layoutPath, layoutOriginal);
    await new Promise((r) => setTimeout(r, 1000));
  });

  test("editing imported layout component updates via HMR", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/prerender-complex"));
    await waitForHydration(page);

    // Layout renders (wraps the prerender content)
    await expect(testId(page, "prerender-complex-layout")).toBeVisible();

    // Add visible marker to the layout
    const modified = layoutOriginal.replace(
      "<Outlet />",
      '<p data-testid="hmr-layout-marker">HMR layout update</p><Outlet />',
    );
    fs.writeFileSync(layoutPath, modified);

    // The new marker should appear via HMR
    await expect(testId(page, "hmr-layout-marker")).toHaveText(
      "HMR layout update",
      { timeout: 15000 },
    );
  });

  // -- Endpoint-level cache invalidation (#654) ---------------------------
  // The identity-keyed dev prerender cache must drop on an HMR edit: the
  // entry chain re-evaluates, createRouter() registers a NEW instance, and
  // the next endpoint request is a MISS carrying the fresh content. This is
  // the precise wire-level counterpart of the page-level tests above.

  test("endpoint cache: warm HIT, edit handler, next request is MISS with fresh content", async ({
    request,
  }) => {
    // No routeName: the runtime dev store always sends one, so the r=""
    // cache key belongs to direct endpoint tests only. warm1 makes no
    // MISS/HIT assumption in case a sibling direct test already warmed it.
    const url = f.url("/__rsc_prerender?pathname=/docs");

    const warm1 = await request.get(url);
    expect(warm1.status()).toBe(200);
    const warm2 = await request.get(url);
    expect(warm2.headers()["x-rango-prerender-cache"]).toBe("HIT");
    expect(await warm2.text()).toContain(
      "This is pre-rendered documentation content.",
    );

    const modified = prerenderOriginal.replace(
      "This is pre-rendered documentation content.",
      "Cache-invalidated pre-rendered content.",
    );
    fs.writeFileSync(prerenderPath, modified);

    // Poll: the watcher must invalidate the chain, the re-import must
    // re-register the router, and the endpoint must re-render fresh.
    await expect
      .poll(
        async () => {
          const res = await request.get(url);
          const body = await res.text();
          return body.includes("Cache-invalidated pre-rendered content.")
            ? res.headers()["x-rango-prerender-cache"]
            : "stale";
        },
        { timeout: 15000 },
      )
      .toBe("MISS");

    // And the fresh body re-memoizes under the new identity. Poll rather
    // than asserting the very next request: the edited file contains urls(),
    // so the route-file watcher's DEBOUNCED rediscovery re-evaluates the
    // chain once more shortly after the immediate HMR invalidation — that
    // trailing cycle produces one more legitimate MISS before the identity
    // stabilizes and requests converge to HIT.
    await expect
      .poll(
        async () => {
          const res = await request.get(url);
          const body = await res.text();
          return body.includes("Cache-invalidated pre-rendered content.")
            ? res.headers()["x-rango-prerender-cache"]
            : "stale";
        },
        { timeout: 15000 },
      )
      .toBe("HIT");
  });
});
