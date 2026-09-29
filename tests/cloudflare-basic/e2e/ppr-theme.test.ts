import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
import { expectNoPageError, waitForHydration } from "./helper";

/**
 * The visitor's theme on a ppr route on workerd/KV (#971). The theme is the
 * visitor's cookie, so a handler that reads ctx.theme or
 * getRequestContext().theme refuses the shared shell capture like a
 * cookies() read: every request is a MISS rendered with that visitor's
 * theme, and no visitor gets a HIT carrying another visitor's theme.
 *
 * Control: /ppr-theme/client reads the theme with useTheme() in a client
 * component and warms to a HIT. The shell carries the no-cookie default
 * (light here), whoever captured it; a visitor with a stored theme gets
 * theirs after hydration. Warming it first also proves the capture pipeline
 * is hot, so the refusing routes' MISSes are refusals, not slow captures.
 * Each run owns its shell keys through a unique probe (the KV store outlives
 * the server).
 */

const visitor = (theme: string) => ({
  Accept: "text/html",
  Cookie: `theme=${theme}`,
});

function uniqueProbe(): string {
  return `theme-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** [surface, route, text prefix] of the handler reads that refuse. */
const REFUSING_READS: Array<[string, string, string]> = [
  ["ctx.theme", "/ppr-theme", "ppr-theme-is-"],
  ["getRequestContext().theme", "/ppr-theme/rc", "ppr-rc-theme-is-"],
];

function runPprThemeSpec(f: Fixture): void {
  for (const [surface, route, prefix] of REFUSING_READS) {
    test(`a ppr route reading ${surface} never serves a HIT with another visitor's theme`, async ({
      request,
    }) => {
      const probe = uniqueProbe();
      await expect(async () => {
        const res = await request.get(
          f.url(`/ppr-theme/client?probe=${probe}`),
          { headers: visitor("dark") },
        );
        expect(res.headers()["x-rango-shell"]).toBe("HIT");
      }).toPass({ timeout: 20000 });

      const url = f.url(`${route}?probe=${probe}`);
      for (const theme of ["dark", "dark", "light", "dark", "light", "light"]) {
        const res = await request.get(url, { headers: visitor(theme) });
        expect(res.status()).toBe(200);
        expect(res.headers()["x-rango-shell"]).toBe("MISS");
        const html = await res.text();
        expect(html).toContain(`${prefix}${theme}`);
        expect(html).not.toContain(
          `${prefix}${theme === "dark" ? "light" : "dark"}`,
        );
        // Room for the MISS's background capture to land, were it stored.
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    });
  }

  test("useTheme() on a ppr route HITs with the default theme, and a stored theme re-syncs", async ({
    browser,
    request,
  }) => {
    const url = f.url(`/ppr-theme/client?probe=${uniqueProbe()}`);
    // A dark visitor's request triggers the capture.
    await expect(async () => {
      const res = await request.get(url, { headers: visitor("dark") });
      expect(res.headers()["x-rango-shell"]).toBe("HIT");
    }).toPass({ timeout: 20000 });

    const shell = await request.get(url, { headers: { Accept: "text/html" } });
    expect(shell.headers()["x-rango-shell"]).toBe("HIT");
    expect(await shell.text()).toMatch(
      /Current theme: (<!-- -->)?<strong>light</,
    );

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
        using _ = expectNoPageError(page);
        const res = await page.goto(url);
        expect(res?.headers()["x-rango-shell"]).toBe("HIT");
        await waitForHydration(page);
        await expect(
          page.getByTestId("cf-ppr-theme-client-page"),
        ).toContainText(`Current theme: ${expected}`);
        await expect(page.locator("html")).toHaveClass(
          new RegExp(`\\b${expected}\\b`),
        );
      } finally {
        await context.close();
      }
    }
  });
}

test.describe("ppr theme (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  runPprThemeSpec(f);
});

test.describe("ppr theme (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  runPprThemeSpec(f);
});
