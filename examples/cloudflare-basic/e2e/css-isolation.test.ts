import { expect, test, type Page } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

async function getComputedColors(
  page: Page,
  testIdValue: string,
): Promise<{ bg: string; color: string }> {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) throw new Error(`Element with data-testid="${id}" not found`);
    const style = getComputedStyle(el);
    return { bg: style.backgroundColor, color: style.color };
  }, testIdValue);
}

// Returns which .css-panel-X classes have rules loaded in any stylesheet.
async function getLoadedPanelRules(page: Page): Promise<Set<string>> {
  const found = await page.evaluate(() => {
    const classes: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules)) {
          if (rule instanceof CSSStyleRule) {
            for (const cls of ["css-panel-a", "css-panel-b", "css-panel-c", "css-panel-d"]) {
              if (rule.selectorText.includes(cls)) {
                classes.push(cls);
              }
            }
          }
        }
      } catch {
        // cross-origin stylesheet, skip
      }
    }
    return classes;
  });
  return new Set(found);
}

// Returns hrefs from <link rel="stylesheet"> tags in the document.
async function getStylesheetLinks(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
      .map((l) => l.getAttribute("href")!)
      .filter(Boolean),
  );
}

// Collect CSS network request URLs. Returns a cleanup function and accessor.
function trackCssRequests(page: Page) {
  const urls: string[] = [];
  const handler = (req: import("@playwright/test").Request) => {
    const url = req.url();
    if (req.resourceType() === "stylesheet" || url.endsWith(".css")) {
      urls.push(url);
    }
  };
  page.on("request", handler);
  return {
    urls: () => [...urls],
    clear() {
      urls.length = 0;
    },
    dispose() {
      page.off("request", handler);
    },
  };
}

const panels = [
  { letter: "a", testId: "css-panel-a", bg: "rgb(255, 0, 0)", color: "rgb(255, 255, 255)" },
  { letter: "b", testId: "css-panel-b", bg: "rgb(0, 128, 0)", color: "rgb(255, 255, 255)" },
  { letter: "c", testId: "css-panel-c", bg: "rgb(0, 0, 255)", color: "rgb(255, 255, 255)" },
  { letter: "d", testId: "css-panel-d", bg: "rgb(255, 165, 0)", color: "rgb(0, 0, 0)" },
] as const;

test.describe.configure({ mode: "serial" });

test.describe("css isolation (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });

  for (const panel of panels) {
    test(`panel ${panel.letter} has correct styles on direct navigation`, async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url(`/css-test/${panel.letter}`));
      await waitForHydration(page);

      await expect(testId(page, panel.testId)).toBeVisible();
      const styles = await getComputedColors(page, panel.testId);
      expect(styles.bg).toBe(panel.bg);
      expect(styles.color).toBe(panel.color);
    });
  }

  test("only the rendered panel CSS is requested on a single-panel page", async ({ page }) => {
    using _ = expectNoPageError(page);
    const css = trackCssRequests(page);

    await page.goto(f.url("/css-test/a"));
    await waitForHydration(page);

    // Network: only panel-a.css was requested
    const urls = css.urls();
    expect(urls.some((u) => u.includes("panel-a"))).toBe(true);
    expect(urls.some((u) => u.includes("panel-b"))).toBe(false);
    expect(urls.some((u) => u.includes("panel-c"))).toBe(false);
    expect(urls.some((u) => u.includes("panel-d"))).toBe(false);

    // DOM: only panel-a stylesheet link present
    const links = await getStylesheetLinks(page);
    expect(links.some((h) => h.includes("panel-a"))).toBe(true);
    expect(links.some((h) => h.includes("panel-b"))).toBe(false);
    expect(links.some((h) => h.includes("panel-c"))).toBe(false);
    expect(links.some((h) => h.includes("panel-d"))).toBe(false);

    // Rules: only panel-a CSS rules in stylesheets
    const rules = await getLoadedPanelRules(page);
    expect(rules.has("css-panel-a")).toBe(true);
    expect(rules.has("css-panel-b")).toBe(false);
    expect(rules.has("css-panel-c")).toBe(false);
    expect(rules.has("css-panel-d")).toBe(false);

    css.dispose();
  });

  test("all four panel CSS files are requested on /css-test/all", async ({ page }) => {
    using _ = expectNoPageError(page);
    const css = trackCssRequests(page);

    await page.goto(f.url("/css-test/all"));
    await waitForHydration(page);

    // Network: all four CSS files requested
    const urls = css.urls();
    expect(urls.some((u) => u.includes("panel-a"))).toBe(true);
    expect(urls.some((u) => u.includes("panel-b"))).toBe(true);
    expect(urls.some((u) => u.includes("panel-c"))).toBe(true);
    expect(urls.some((u) => u.includes("panel-d"))).toBe(true);

    // Rules + computed styles
    const rules = await getLoadedPanelRules(page);
    for (const panel of panels) {
      expect(rules.has(panel.testId)).toBe(true);

      await expect(testId(page, panel.testId)).toBeVisible();
      const styles = await getComputedColors(page, panel.testId);
      expect(styles.bg).toBe(panel.bg);
      expect(styles.color).toBe(panel.color);
    }

    css.dispose();
  });

  test("partial navigation fetches new panel CSS from the network", async ({ page }) => {
    using _ = expectNoPageError(page);
    const css = trackCssRequests(page);

    await page.goto(f.url("/css-test/a"));
    await waitForHydration(page);

    // Initial: only panel-a requested
    expect(css.urls().some((u) => u.includes("panel-a"))).toBe(true);
    expect(css.urls().some((u) => u.includes("panel-b"))).toBe(false);

    await expect(testId(page, "css-panel-a")).toBeVisible();
    let styles = await getComputedColors(page, "css-panel-a");
    expect(styles.bg).toBe("rgb(255, 0, 0)");

    // Partial nav to B: panel-b.css fetched
    css.clear();
    await testId(page, "css-nav-b").click();
    await expect(testId(page, "css-panel-b")).toBeVisible();

    expect(css.urls().some((u) => u.includes("panel-b"))).toBe(true);
    expect(css.urls().some((u) => u.includes("panel-c"))).toBe(false);
    expect(css.urls().some((u) => u.includes("panel-d"))).toBe(false);

    styles = await getComputedColors(page, "css-panel-b");
    expect(styles.bg).toBe("rgb(0, 128, 0)");

    // Partial nav to C: panel-c.css fetched
    css.clear();
    await testId(page, "css-nav-c").click();
    await expect(testId(page, "css-panel-c")).toBeVisible();

    expect(css.urls().some((u) => u.includes("panel-c"))).toBe(true);
    expect(css.urls().some((u) => u.includes("panel-d"))).toBe(false);

    styles = await getComputedColors(page, "css-panel-c");
    expect(styles.bg).toBe("rgb(0, 0, 255)");

    // Partial nav to D: panel-d.css fetched
    css.clear();
    await testId(page, "css-nav-d").click();
    await expect(testId(page, "css-panel-d")).toBeVisible();

    expect(css.urls().some((u) => u.includes("panel-d"))).toBe(true);

    styles = await getComputedColors(page, "css-panel-d");
    expect(styles.bg).toBe("rgb(255, 165, 0)");

    css.dispose();
  });
});

test.describe("css isolation (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });

  for (const panel of panels) {
    test(`panel ${panel.letter} has correct styles on direct navigation`, async ({ page }) => {
      using _ = expectNoPageError(page);

      await page.goto(f.url(`/css-test/${panel.letter}`));
      await waitForHydration(page);

      await expect(testId(page, panel.testId)).toBeVisible();
      const styles = await getComputedColors(page, panel.testId);
      expect(styles.bg).toBe(panel.bg);
      expect(styles.color).toBe(panel.color);
    });
  }

  test("CSS bundle is fetched on initial load", async ({ page }) => {
    using _ = expectNoPageError(page);
    const css = trackCssRequests(page);

    await page.goto(f.url("/css-test/a"));
    await waitForHydration(page);

    // Production: single CSS bundle fetched via network
    const urls = css.urls();
    expect(urls.length).toBeGreaterThanOrEqual(1);
    expect(urls.some((u) => u.includes("/assets/") && u.endsWith(".css"))).toBe(true);

    // Bundle contains all panel rules
    const rules = await getLoadedPanelRules(page);
    expect(rules.has("css-panel-a")).toBe(true);

    css.dispose();
  });

  test("all panels have correct styles on /css-test/all", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/css-test/all"));
    await waitForHydration(page);

    const rules = await getLoadedPanelRules(page);
    for (const panel of panels) {
      expect(rules.has(panel.testId)).toBe(true);

      await expect(testId(page, panel.testId)).toBeVisible();
      const styles = await getComputedColors(page, panel.testId);
      expect(styles.bg).toBe(panel.bg);
      expect(styles.color).toBe(panel.color);
    }
  });

  test("CSS bundle is fetched once, no new CSS requests on partial navigation", async ({ page }) => {
    using _ = expectNoPageError(page);
    const css = trackCssRequests(page);

    await page.goto(f.url("/css-test/a"));
    await waitForHydration(page);

    // Initial load fetches the CSS bundle
    const initialUrls = css.urls();
    expect(initialUrls.some((u) => u.includes("/assets/") && u.endsWith(".css"))).toBe(true);

    await expect(testId(page, "css-panel-a")).toBeVisible();
    let styles = await getComputedColors(page, "css-panel-a");
    expect(styles.bg).toBe("rgb(255, 0, 0)");

    // Partial nav to B: no new CSS requests (bundle already loaded)
    css.clear();
    await testId(page, "css-nav-b").click();
    await expect(testId(page, "css-panel-b")).toBeVisible();

    const afterNavB = css.urls().filter((u) => u.endsWith(".css"));
    expect(afterNavB).toHaveLength(0);

    styles = await getComputedColors(page, "css-panel-b");
    expect(styles.bg).toBe("rgb(0, 128, 0)");

    // Partial nav to C: no new CSS requests
    css.clear();
    await testId(page, "css-nav-c").click();
    await expect(testId(page, "css-panel-c")).toBeVisible();

    const afterNavC = css.urls().filter((u) => u.endsWith(".css"));
    expect(afterNavC).toHaveLength(0);

    styles = await getComputedColors(page, "css-panel-c");
    expect(styles.bg).toBe("rgb(0, 0, 255)");

    // Partial nav to D: no new CSS requests
    css.clear();
    await testId(page, "css-nav-d").click();
    await expect(testId(page, "css-panel-d")).toBeVisible();

    const afterNavD = css.urls().filter((u) => u.endsWith(".css"));
    expect(afterNavD).toHaveLength(0);

    styles = await getComputedColors(page, "css-panel-d");
    expect(styles.bg).toBe("rgb(255, 165, 0)");

    // CSS rules still present after all partial navs
    const rules = await getLoadedPanelRules(page);
    expect(rules.has("css-panel-a")).toBe(true);
    expect(rules.has("css-panel-b")).toBe(true);
    expect(rules.has("css-panel-c")).toBe(true);
    expect(rules.has("css-panel-d")).toBe(true);

    css.dispose();
  });

  test("partial nav to /css-test/all renders all panels correctly", async ({ page }) => {
    using _ = expectNoPageError(page);

    await page.goto(f.url("/css-test/a"));
    await waitForHydration(page);

    // Partial nav to all-panels page
    await testId(page, "css-nav-all").click();
    await expect(testId(page, "css-panel-d")).toBeVisible();

    for (const panel of panels) {
      await expect(testId(page, panel.testId)).toBeVisible();
      const styles = await getComputedColors(page, panel.testId);
      expect(styles.bg).toBe(panel.bg);
      expect(styles.color).toBe(panel.color);
    }
  });
});
