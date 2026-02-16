import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";
import { waitForHydration, testId } from "./helper";

/**
 * Theme functionality tests - testing theme provider, useTheme hook, and ctx.theme
 */
test.describe("theme", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  test.describe("server-side theme", () => {
    test("should have access to ctx.theme in route handlers", async ({ page }) => {
      await page.goto(f.url("/theme"));
      await waitForHydration(page);

      // Server should have theme available (defaults to "light" when no cookie)
      const serverTheme = testId(page, "server-theme");
      await expect(serverTheme).toContainText("light");
    });

    test("should include theme script in initial HTML", async ({ request }) => {
      const response = await request.get(f.url("/theme"), {
        headers: { Accept: "text/html,application/xhtml+xml" },
      });
      const html = await response.text();

      // Theme script should be inline in head to prevent FOUC
      // The script uses a variable `storageKey` for the key name
      expect(html).toContain("localStorage.getItem(storageKey)");
      expect(html).toContain("prefers-color-scheme");
    });
  });

  test.describe("client-side theme", () => {
    test("should render theme toggle with all theme options", async ({ page }) => {
      await page.goto(f.url("/theme/toggle"));
      await waitForHydration(page);

      // Theme toggle should be visible
      await expect(testId(page, "theme-toggle")).toBeVisible();

      // Should show available themes
      const availableThemes = testId(page, "theme-toggle-available-themes");
      await expect(availableThemes).toContainText("light");
      await expect(availableThemes).toContainText("dark");
      await expect(availableThemes).toContainText("system");
    });

    test("should show current theme state", async ({ page }) => {
      await page.goto(f.url("/theme/toggle"));
      await waitForHydration(page);

      // Should display current theme
      const currentTheme = testId(page, "theme-toggle-current-theme");
      await expect(currentTheme).toBeVisible();

      // Should display resolved theme
      const resolvedTheme = testId(page, "theme-toggle-resolved-theme");
      await expect(resolvedTheme).toBeVisible();

      // Should display system theme
      const systemTheme = testId(page, "theme-toggle-system-theme");
      await expect(systemTheme).toBeVisible();
    });

    test("should switch theme when clicking theme buttons", async ({ page }) => {
      await page.goto(f.url("/theme/toggle"));
      await waitForHydration(page);

      // Click dark theme button
      await testId(page, "theme-toggle-set-dark").click();

      // Should update current theme display
      const currentTheme = testId(page, "theme-toggle-current-theme");
      await expect(currentTheme).toContainText("dark");

      // Should update resolved theme
      const resolvedTheme = testId(page, "theme-toggle-resolved-theme");
      await expect(resolvedTheme).toContainText("dark");

      // Click light theme button
      await testId(page, "theme-toggle-set-light").click();

      // Should update to light
      await expect(currentTheme).toContainText("light");
      await expect(resolvedTheme).toContainText("light");
    });

    test("should apply theme class to documentElement", async ({ page }) => {
      await page.goto(f.url("/theme/toggle"));
      await waitForHydration(page);

      // Set dark theme
      await testId(page, "theme-toggle-set-dark").click();

      // Wait for theme class to be applied
      await expect(page.locator("html")).toHaveClass(/dark/);

      // Set light theme
      await testId(page, "theme-toggle-set-light").click();

      // Should have light class (or no dark class)
      await expect(page.locator("html")).toHaveClass(/light/);
    });
  });

  test.describe("theme persistence", () => {
    test("should persist theme in localStorage", async ({ page }) => {
      await page.goto(f.url("/theme/toggle"));
      await waitForHydration(page);

      // Set dark theme
      await testId(page, "theme-toggle-set-dark").click();

      // Check localStorage
      const storedTheme = await page.evaluate(() => localStorage.getItem("theme"));
      expect(storedTheme).toBe("dark");

      // Set light theme
      await testId(page, "theme-toggle-set-light").click();

      // Check localStorage
      const storedTheme2 = await page.evaluate(() => localStorage.getItem("theme"));
      expect(storedTheme2).toBe("light");
    });

    test("should set theme cookie for SSR", async ({ page }) => {
      await page.goto(f.url("/theme/toggle"));
      await waitForHydration(page);

      // Set dark theme
      await testId(page, "theme-toggle-set-dark").click();

      // Check cookie
      const cookies = await page.context().cookies();
      const themeCookie = cookies.find((c) => c.name === "theme");
      expect(themeCookie).toBeDefined();
      expect(themeCookie?.value).toBe("dark");
    });

    test("should restore theme after page reload", async ({ page }) => {
      await page.goto(f.url("/theme/toggle"));
      await waitForHydration(page);

      // Set dark theme
      await testId(page, "theme-toggle-set-dark").click();

      // Verify it's set
      await expect(testId(page, "theme-toggle-current-theme")).toContainText("dark");

      // Reload page
      await page.reload();
      await waitForHydration(page);

      // Theme should be restored
      await expect(testId(page, "theme-toggle-current-theme")).toContainText("dark");
      await expect(page.locator("html")).toHaveClass(/dark/);
    });
  });

  test.describe("FOUC prevention", () => {
    test("should apply theme before hydration", async ({ page }) => {
      // Set a theme cookie first
      await page.context().addCookies([
        {
          name: "theme",
          value: "dark",
          domain: new URL(f.url("/")).hostname,
          path: "/",
        },
      ]);

      // Navigate to page
      await page.goto(f.url("/theme/toggle"));

      // Check that dark class is applied immediately (before hydration)
      // by checking the initial HTML state
      const htmlClass = await page.evaluate(() => {
        return document.documentElement.className;
      });

      expect(htmlClass).toContain("dark");
    });

    test("should use inline script for immediate theme application", async ({ request }) => {
      const response = await request.get(f.url("/theme/toggle"), {
        headers: { Accept: "text/html,application/xhtml+xml" },
      });
      const html = await response.text();

      // Should have inline script that runs immediately
      // The script should be before the body content to prevent FOUC
      // The script uses a variable `storageKey` for the key name
      const scriptIndex = html.indexOf("localStorage.getItem(storageKey)");
      const bodyIndex = html.indexOf("<body");

      // Script should appear in the <head> before <body>
      expect(scriptIndex).toBeGreaterThan(-1);
      expect(scriptIndex).toBeLessThan(bodyIndex);
    });
  });

  test.describe("system theme detection", () => {
    test("should detect system theme preference", async ({ page }) => {
      // Emulate dark color scheme preference
      await page.emulateMedia({ colorScheme: "dark" });

      await page.goto(f.url("/theme/toggle"));
      await waitForHydration(page);

      // System theme should show "dark"
      const systemTheme = testId(page, "theme-toggle-system-theme");
      await expect(systemTheme).toContainText("dark");

      // Emulate light color scheme preference
      await page.emulateMedia({ colorScheme: "light" });

      // Need to wait for media query listener to fire
      await page.waitForTimeout(100);

      // System theme should update to "light"
      await expect(systemTheme).toContainText("light");
    });

    test("should resolve 'system' theme to actual preference", async ({ page }) => {
      // Emulate dark color scheme
      await page.emulateMedia({ colorScheme: "dark" });

      await page.goto(f.url("/theme/toggle"));
      await waitForHydration(page);

      // Set theme to "system"
      await testId(page, "theme-toggle-set-system").click();

      // Current theme should be "system"
      await expect(testId(page, "theme-toggle-current-theme")).toContainText("system");

      // Resolved theme should be "dark" (matching system preference)
      await expect(testId(page, "theme-toggle-resolved-theme")).toContainText("dark");

      // HTML should have dark class
      await expect(page.locator("html")).toHaveClass(/dark/);
    });
  });

  test.describe("navigation and SSR", () => {
    test("should maintain theme during soft navigation", async ({ page }) => {
      await page.goto(f.url("/theme/toggle"));
      await waitForHydration(page);

      // Set dark theme
      await testId(page, "theme-toggle-set-dark").click();
      await expect(page.locator("html")).toHaveClass(/dark/);

      // Navigate to theme index
      await testId(page, "back-link").click();
      await expect(testId(page, "theme-index-page")).toBeVisible({ timeout: 5000 });

      // Theme should be maintained
      await expect(page.locator("html")).toHaveClass(/dark/);

      // Navigate back to toggle
      await testId(page, "theme-toggle-link").click();
      await expect(testId(page, "theme-toggle-page")).toBeVisible({ timeout: 5000 });

      // Theme should still be dark
      await expect(testId(page, "theme-toggle-current-theme")).toContainText("dark");
    });

    test("should read theme from cookie on SSR", async ({ page }) => {
      // Set theme cookie
      await page.context().addCookies([
        {
          name: "theme",
          value: "dark",
          domain: new URL(f.url("/")).hostname,
          path: "/",
        },
      ]);

      await page.goto(f.url("/theme"));
      await waitForHydration(page);

      // Server should read theme from cookie
      const serverTheme = testId(page, "server-theme");
      await expect(serverTheme).toContainText("dark");
    });
  });

  test.describe("no hydration mismatch", () => {
    test("should not have hydration errors on theme pages", async ({ page }) => {
      const hydrationErrors: string[] = [];

      page.on("console", (msg) => {
        const text = msg.text();
        if (
          text.includes("Hydration failed") ||
          text.includes("hydration mismatch") ||
          text.includes("Text content does not match")
        ) {
          hydrationErrors.push(text);
        }
      });

      // Test theme index
      await page.goto(f.url("/theme"));
      await waitForHydration(page);
      expect(hydrationErrors).toEqual([]);

      // Test theme toggle
      await page.goto(f.url("/theme/toggle"));
      await waitForHydration(page);
      expect(hydrationErrors).toEqual([]);
    });

    test("should not have hydration errors with pre-set theme", async ({ page }) => {
      const hydrationErrors: string[] = [];

      page.on("console", (msg) => {
        const text = msg.text();
        if (
          text.includes("Hydration failed") ||
          text.includes("hydration mismatch") ||
          text.includes("Text content does not match")
        ) {
          hydrationErrors.push(text);
        }
      });

      // Set theme cookie
      await page.context().addCookies([
        {
          name: "theme",
          value: "dark",
          domain: new URL(f.url("/")).hostname,
          path: "/",
        },
      ]);

      await page.goto(f.url("/theme/toggle"));
      await waitForHydration(page);

      expect(hydrationErrors).toEqual([]);
    });
  });
});
