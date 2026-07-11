import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import {
  waitForHydration,
  expectNoPageError,
  testId,
  expectNoReload,
  waitForNavigation,
} from "./helper";
import { guardHydrationErrors, writeFileAndAwaitHmr } from "@shared/e2e";
import fs from "node:fs";
import path from "node:path";

test.describe("hmr", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  const pprShellPath = path.join(f.root, "src/pages/ppr-shell.tsx");
  let pprShellOriginal = "";

  test.beforeAll(() => {
    pprShellOriginal = fs.readFileSync(pprShellPath, "utf-8");
  });

  const HTML_HEADERS = { Accept: "text/html" };
  const RSC_VERSION_PATTERN = /\[rango\] RSC module changed, version updated:/;

  async function warmPprToHit(
    request: Page["request"],
    url: string,
  ): Promise<void> {
    await expect(async () => {
      const response = await request.get(url, { headers: HTML_HEADERS });
      expect(response.status()).toBe(200);
      await response.text();
      expect(response.headers()["x-rango-shell"]).toBe("HIT");
    }).toPass({ timeout: 30_000 });
  }

  async function writeAndApplyHmr(
    page: Page,
    content: string,
    waitForApplied: () => Promise<void>,
  ): Promise<void> {
    await writeFileAndAwaitHmr(page, pprShellPath, content, {
      totalTimeoutMs: 30_000,
      getServerOutput: () => f.proc().stdout(),
      serverOutputPattern: RSC_VERSION_PATTERN,
      waitForApplied,
    });
  }

  async function writeAndWaitForHmr(
    page: Page,
    content: string,
  ): Promise<void> {
    await writeFileAndAwaitHmr(page, pprShellPath, content, {
      totalTimeoutMs: 30_000,
      getServerOutput: () => f.proc().stdout(),
      serverOutputPattern: RSC_VERSION_PATTERN,
    });
  }

  // Store original file contents for cleanup
  const originalContents = new Map<string, string>();

  test.afterEach(() => {
    // Restore all modified files after each test to ensure clean state
    for (const [filePath, content] of originalContents) {
      fs.writeFileSync(filePath, content, "utf-8");
    }
    originalContents.clear();
  });

  /**
   * Trigger HMR by modifying a file and wait for the RSC stream to complete.
   * Optionally makes a visible content change and returns the expected new text.
   */
  async function triggerHMRAndWait(
    page: Page,
    filePath: string,
    options?: { visibleChange?: { search: string; replace: string } },
  ): Promise<{ expectedText?: string }> {
    const fullPath = path.join(f.root, filePath);
    const content = fs.readFileSync(fullPath, "utf-8");

    // Save original content on first modification
    if (!originalContents.has(fullPath)) {
      originalContents.set(fullPath, content);
    }

    let newContent = content;
    let expectedText: string | undefined;

    // Apply visible change if specified
    if (options?.visibleChange) {
      const { search, replace } = options.visibleChange;
      if (content.includes(search)) {
        newContent = content.replace(search, replace);
        expectedText = replace;
      }
    }

    // Always add/update HMR trigger marker to ensure file change is detected
    const marker = `// HMR trigger: ${Date.now()}`;
    newContent = newContent.includes("// HMR trigger:")
      ? newContent.replace(/\/\/ HMR trigger: \d+/, marker)
      : newContent + `\n${marker}\n`;

    const hmrComplete = page.waitForEvent("console", {
      predicate: (msg) => msg.text().includes("RSC stream complete"),
      timeout: 15000,
    });

    fs.writeFileSync(fullPath, newContent, "utf-8");

    await hmrComplete;
    await page.waitForTimeout(200);

    return { expectedText };
  }

  // First HMR trigger after `rm -rf node_modules/.vite` may cause Vite to
  // re-discover optimized dependencies → full page reload instead of the
  // incremental `rsc:update` event. This warmup absorbs that reload so
  // subsequent tests get clean HMR updates.
  test("warmup: preheat dep optimizer with dummy HMR", async ({ page }) => {
    test.setTimeout(60_000);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    const fullPath = path.join(f.root, "src/pages/home.tsx");
    const original = fs.readFileSync(fullPath, "utf-8");
    const marker = `\n// HMR warmup: ${Date.now()}\n`;
    fs.writeFileSync(fullPath, original + marker, "utf-8");

    // Wait for either rsc:update (fast path) or a full reload (dep optimization).
    // After dep optimization, the page reloads and re-hydrates.
    await expect(async () => {
      await page.reload();
      await waitForHydration(page);
      await expect(testId(page, "home-page")).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 30_000, intervals: [2_000, 3_000, 5_000] });

    // Restore original
    fs.writeFileSync(fullPath, original, "utf-8");
    // Let the restore HMR settle
    await page.waitForTimeout(3000);
  });

  test("should update content after HMR without page reload", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await expect(testId(page, "home-page")).toBeVisible();

    await using __ = await expectNoReload(page);

    await triggerHMRAndWait(page, "src/pages/home.tsx");

    await expect(testId(page, "home-page")).toBeVisible();
  });

  test("should update about page content after HMR", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/about"));
    await waitForHydration(page);

    await expect(testId(page, "about-page")).toBeVisible();
    await expect(testId(page, "about-title")).toHaveText("About");

    await using __ = await expectNoReload(page);

    // Make a visible change and verify it appears
    const { expectedText } = await triggerHMRAndWait(
      page,
      "src/pages/about.tsx",
      {
        visibleChange: {
          search: ">About</h1>",
          replace: ">About (HMR Updated)</h1>",
        },
      },
    );

    await expect(testId(page, "about-page")).toBeVisible();
    await expect(testId(page, "about-title")).toHaveText("About (HMR Updated)");
  });

  test("should preserve navigation after HMR", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/"));
    await waitForHydration(page);

    await testId(page, "nav-about").click();
    await expect(testId(page, "about-page")).toBeVisible();
    await expect(testId(page, "about-title")).toHaveText("About");

    // Only monitor for reload during HMR, not during subsequent navigation
    {
      await using __ = await expectNoReload(page);

      // Make a visible change and verify it appears without reload
      await triggerHMRAndWait(page, "src/pages/about.tsx", {
        visibleChange: {
          search: ">About</h1>",
          replace: ">About (HMR Updated)</h1>",
        },
      });

      await expect(testId(page, "about-page")).toBeVisible();
      await expect(testId(page, "about-title")).toHaveText(
        "About (HMR Updated)",
      );
      await expect(testId(page, "nav")).toBeVisible();
    }

    // Navigation after HMR should still work
    await testId(page, "nav-home").click();
    await expect(testId(page, "home-page")).toBeVisible();
  });

  test("should preserve counter state after HMR", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/counter"));
    await waitForHydration(page);

    await expect(testId(page, "counter-page")).toBeVisible();

    await testId(page, "counter-increment").click();
    await expect(testId(page, "counter-pending")).not.toBeVisible({
      timeout: 10000,
    });

    const countBefore = await testId(page, "counter-value").textContent();

    await using __ = await expectNoReload(page);

    await triggerHMRAndWait(page, "src/pages/counter.tsx");

    await expect(testId(page, "counter-page")).toBeVisible();
    const countAfter = await testId(page, "counter-value").textContent();
    expect(countAfter).toBe(countBefore);
  });

  // HMR is dev-only and parity-allowlisted. The underlying document and
  // partial-navigation PPR contracts run in dev + production in ppr-shell.test.
  test("PPR document HMR rejects the old shell and recaptures fresh content", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const url = f.url("/ppr-shell?probe=hmr-document");
    const baseline = "PPR Shell Demo";
    const updated = "PPR Shell Demo (HMR Updated)";
    const modified = pprShellOriginal.replace(baseline, updated);
    expect(modified).not.toBe(pprShellOriginal);

    await warmPprToHit(page.request, url);
    using _ = expectNoPageError(page);
    using __ = guardHydrationErrors(page);

    const navigation = await page.goto(url);
    expect(navigation?.headers()["x-rango-shell"]).toBe("HIT");
    await waitForHydration(page);
    await expect(testId(page, "ppr-shell-header")).toHaveText(baseline);

    try {
      await using ___ = await expectNoReload(page);
      await writeAndApplyHmr(page, modified, async () => {
        await expect(testId(page, "ppr-shell-header")).toHaveText(updated);
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
      }).toPass({ timeout: 30_000 });
    } finally {
      await writeAndApplyHmr(page, pprShellOriginal, async () => {
        await expect(testId(page, "ppr-shell-header")).toHaveText(baseline);
      });
    }
  });

  test("PPR partial navigation rejects an old shell snapshot after HMR", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const sourceUrl = f.url("/ppr-shell?probe=hmr-partial-source");
    const targetUrl = f.url("/ppr-shell/exec-matrix");
    const baseline = "Exec matrix static chrome";
    const updated = "Exec matrix static chrome (HMR Updated)";
    const modified = pprShellOriginal.replace(baseline, updated);
    expect(modified).not.toBe(pprShellOriginal);

    await warmPprToHit(page.request, sourceUrl);
    await warmPprToHit(page.request, targetUrl);
    using _ = expectNoPageError(page);
    using __ = guardHydrationErrors(page);

    const sourceNavigation = await page.goto(sourceUrl);
    expect(sourceNavigation?.headers()["x-rango-shell"]).toBe("HIT");
    await waitForHydration(page);

    try {
      await using ___ = await expectNoReload(page);
      await writeAndWaitForHmr(page, modified);

      const partialResponsePromise = page.waitForResponse((response) => {
        const responseUrl = new URL(response.url());
        return (
          responseUrl.pathname === "/ppr-shell/exec-matrix" &&
          responseUrl.searchParams.has("_rsc_partial")
        );
      });
      await testId(page, "nav-ppr-exec").click();
      const partialResponse = await partialResponsePromise;
      await waitForNavigation(page, /\/ppr-shell\/exec-matrix$/);

      expect(partialResponse.status()).toBe(200);
      expect(
        partialResponse.request().headers()["x-rsc-router-client-path"],
      ).toBeTruthy();
      expect(partialResponse.headers()["x-rango-shell"]).toBeUndefined();
      expect(await partialResponse.text()).toContain(updated);
      await expect(testId(page, "ppr-exec-chrome")).toHaveText(updated);
    } finally {
      await writeAndApplyHmr(page, pprShellOriginal, async () => {
        await expect(testId(page, "ppr-exec-chrome")).toHaveText(baseline);
      });
    }
  });
});
