import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  expectNoReload,
  testId,
  waitForNavigation,
  writeFileAndAwaitHmr,
  writeFileBumpMtime,
} from "./helper";
import { guardHydrationErrors } from "@shared/e2e";
import fs from "node:fs";
import path from "node:path";

/**
 * HMR tests for pre-rendered, static, and PPR content.
 *
 * Verifies that editing a Prerender() or Static() handler — and
 * components they import — applies the change via HMR in dev mode. PPR cases
 * additionally pin stale document-shell and partial-replay invalidation.
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

  const HTML_HEADERS = { Accept: "text/html" };

  async function warmPprToHit(
    request: Page["request"],
    url: string,
  ): Promise<void> {
    await expect(async () => {
      const response = await request.get(url, { headers: HTML_HEADERS });
      expect(response.status()).toBe(200);
      await response.text();
      expect(response.headers()["x-rango-shell"]).toBe("HIT");
    }).toPass({ timeout: 20_000 });
  }

  async function writeAndApplyHmr(
    page: Page,
    filePath: string,
    content: string,
    waitForApplied: () => Promise<void>,
  ): Promise<void> {
    await writeFileAndAwaitHmr(page, filePath, content, {
      totalTimeoutMs: 20_000,
      waitForApplied,
    });
  }

  async function writeAndWaitForHmr(
    page: Page,
    filePath: string,
    content: string,
  ): Promise<void> {
    const complete = page.waitForEvent("console", {
      predicate: (message) =>
        message.text().includes("[Rango] HMR: RSC stream complete"),
      timeout: 20_000,
    });
    writeFileBumpMtime(filePath, content);
    await complete;
  }

  // -- Prerender() handler file test (contains urls()) --------------------

  const prerenderPath = path.resolve("./e2e/test-app/src/urls/prerender.tsx");
  const shellCachePath = path.resolve(
    "./e2e/test-app/src/urls/shell-cache.tsx",
  );
  let prerenderOriginal: string;
  let shellCacheOriginal: string;

  test.beforeAll(async () => {
    prerenderOriginal = fs.readFileSync(prerenderPath, "utf-8");
    shellCacheOriginal = fs.readFileSync(shellCachePath, "utf-8");
  });

  test.afterAll(async () => {
    fs.writeFileSync(prerenderPath, prerenderOriginal);
    fs.writeFileSync(shellCachePath, shellCacheOriginal);
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

  test("PPR document HMR rejects the old shell and recaptures fresh content", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const url = f.url("/shell-cache?probe=hmr-document");
    const baseline = "Shell Cache Demo";
    const updated = "Shell Cache Demo (HMR Updated)";
    const modified = shellCacheOriginal.replace(baseline, updated);
    expect(modified).not.toBe(shellCacheOriginal);

    await warmPprToHit(page.request, url);
    using _ = expectNoPageError(page);
    using __ = guardHydrationErrors(page);

    const navigation = await page.goto(url);
    expect(navigation?.headers()["x-rango-shell"]).toBe("HIT");
    await waitForHydration(page);
    await expect(testId(page, "shell-cache-header")).toHaveText(baseline);

    try {
      await using ___ = await expectNoReload(page);
      await writeAndApplyHmr(page, shellCachePath, modified, async () => {
        await expect(testId(page, "shell-cache-header")).toHaveText(updated);
      });

      const miss = await page.request.get(url, { headers: HTML_HEADERS });
      expect(miss.status()).toBe(200);
      expect(miss.headers()["x-rango-shell"]).toBe("MISS");
      expect(await miss.text()).toContain(updated);

      await expect(async () => {
        const hit = await page.request.get(url, { headers: HTML_HEADERS });
        expect(hit.status()).toBe(200);
        const html = await hit.text();
        expect(hit.headers()["x-rango-shell"]).toBe("HIT");
        const preludeEnd = html.indexOf("</html>");
        expect(preludeEnd).toBeGreaterThan(-1);
        expect(html.slice(0, preludeEnd)).toContain(updated);
      }).toPass({ timeout: 20_000 });
    } finally {
      await writeAndApplyHmr(
        page,
        shellCachePath,
        shellCacheOriginal,
        async () => {
          await expect(testId(page, "shell-cache-header")).toHaveText(baseline);
        },
      );
    }
  });

  test("PPR partial navigation rejects an old shell snapshot after HMR", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const sourceUrl = f.url("/shell-cache?probe=hmr-partial-source");
    const targetUrl = f.url("/shell-cache/exec-matrix");
    const baseline = "Exec matrix static chrome";
    const updated = "Exec matrix static chrome (HMR Updated)";
    const modified = shellCacheOriginal.replace(baseline, updated);
    expect(modified).not.toBe(shellCacheOriginal);

    await warmPprToHit(page.request, sourceUrl);
    await warmPprToHit(page.request, targetUrl);
    using _ = expectNoPageError(page);
    using __ = guardHydrationErrors(page);

    const sourceNavigation = await page.goto(sourceUrl);
    expect(sourceNavigation?.headers()["x-rango-shell"]).toBe("HIT");
    await waitForHydration(page);

    try {
      await using ___ = await expectNoReload(page);
      await writeAndWaitForHmr(page, shellCachePath, modified);

      const partialResponsePromise = page.waitForResponse((response) => {
        const responseUrl = new URL(response.url());
        return (
          responseUrl.pathname === "/shell-cache/exec-matrix" &&
          responseUrl.searchParams.has("_rsc_partial")
        );
      });
      await testId(page, "nav-ppr-exec").click();
      const partialResponse = await partialResponsePromise;
      await waitForNavigation(page, /\/shell-cache\/exec-matrix$/);

      expect(partialResponse.status()).toBe(200);
      expect(
        partialResponse.request().headers()["x-rsc-router-client-path"],
      ).toBeTruthy();
      expect(partialResponse.headers()["x-rango-shell"]).toBeUndefined();
      expect(await partialResponse.text()).toContain(updated);
      await expect(testId(page, "shell-exec-chrome")).toHaveText(updated);
    } finally {
      await writeAndApplyHmr(
        page,
        shellCachePath,
        shellCacheOriginal,
        async () => {
          await expect(testId(page, "shell-exec-chrome")).toHaveText(baseline);
        },
      );
    }
  });
});
