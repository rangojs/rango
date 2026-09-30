import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
import { waitForHydration } from "./helper";

/**
 * useTheme() on a document-cached page (#978). A stored document serves
 * every visitor, so its payload carries the no-cookie default (test-app:
 * light) as initialTheme, whoever stored it: a dark visitor warms the entry,
 * a visitor with no stored theme gets light from the HIT, and a visitor with
 * a stored theme gets it after hydration. /theme/doc-cache/live sends no
 * s-maxage, so each visitor's render carries their own theme. Each test owns
 * its entries through a unique probe (the store lives as long as the server).
 */

const visitor = (theme: string) => ({
  Accept: "text/html",
  Cookie: `theme=${theme}`,
});

function uniqueProbe(): string {
  return `theme-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function runThemeDocCacheSpec(f: Fixture): void {
  test("a document-cache HIT a dark visitor warmed carries the default theme, and a stored theme re-syncs", async ({
    browser,
    request,
  }) => {
    const url = f.url(`/theme/doc-cache?probe=${uniqueProbe()}`);
    const miss = await request.get(url, { headers: visitor("dark") });
    expect(miss.headers()["x-document-cache-status"]).toBe("MISS");
    await expect(async () => {
      const res = await request.get(url, { headers: visitor("dark") });
      expect(res.headers()["x-document-cache-status"]).toBe("HIT");
    }).toPass({ timeout: 15000 });

    const hit = await request.get(url, { headers: { Accept: "text/html" } });
    expect(hit.headers()["x-document-cache-status"]).toBe("HIT");
    expect(await hit.text()).toMatch(/Current theme: (<!-- -->)?light</);

    for (const [cookie, expected] of [
      [null, "light"],
      ["light", "light"],
      ["dark", "dark"],
    ] as const) {
      const context = await browser.newContext();
      try {
        if (cookie) {
          await context.addCookies([
            { name: "theme", value: cookie, url: f.url("/") },
          ]);
        }
        const page = await context.newPage();
        const res = await page.goto(url);
        expect(res?.headers()["x-document-cache-status"]).toBe("HIT");
        await waitForHydration(page);
        await expect(
          page.getByTestId("theme-doc-cache-current-theme"),
        ).toHaveText(`Current theme: ${expected}`);
        await expect(page.locator("html")).toHaveClass(
          new RegExp(`\\b${expected}\\b`),
        );
      } finally {
        await context.close();
      }
    }
  });

  test("a document the cache does not store carries each visitor's own theme", async ({
    request,
  }) => {
    const url = f.url(`/theme/doc-cache/live?probe=${uniqueProbe()}`);
    for (const theme of ["dark", "light", "dark"]) {
      const res = await request.get(url, { headers: visitor(theme) });
      expect(res.status()).toBe(200);
      expect(res.headers()["x-document-cache-status"]).toBeUndefined();
      expect(await res.text()).toMatch(
        new RegExp(`Current theme: (<!-- -->)?${theme}<`),
      );
    }
  });
}

test.describe("theme document cache", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  runThemeDocCacheSpec(f);
});

test.describe("theme document cache (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  runThemeDocCacheSpec(f);
});
